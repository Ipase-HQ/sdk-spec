// Compiles ../schema/batch.schema.json into two validators: one for the envelope
// (sent_at plus batch as an array of objects, items unchecked) and one for a single event.
// Envelope failures are a 400; event failures become per-event rejections in a 202.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv ships CommonJS; under Node ESM the default import is module.exports, and the class sits on .default.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const DEFAULT_SCHEMA_PATH = fileURLToPath(new URL("../../schema/batch.schema.json", import.meta.url));
export const DEFAULT_VERSION_PATH = fileURLToPath(new URL("../../VERSION", import.meta.url));

// The reason codes protocol.md lists for entries in a 202 body's rejected array.
export type RejectionReason =
  | "schema_invalid"
  | "event_too_large"
  | "properties_too_many"
  | "property_value_too_long"
  | "reserved_name"
  | "duplicate_event_id"
  | "timestamp_out_of_range";

export interface Validators {
  schemaId: string;
  envelope: ValidateFunction;
  event: ValidateFunction;
}

export function loadValidators(schemaPath: string = DEFAULT_SCHEMA_PATH): Validators {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  // strictRequired is off: ajv evaluates if/then before properties, so it cannot see that the
  // properties the then-branches require are defined on the event. allowUnionTypes is on because property
  // values are a scalar union. Every other strict check stays on.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  ajv.compile(schema); // registers the schema under its $id so the $ref below resolves

  const envelope = structuredClone(schema);
  delete envelope.$id;
  delete envelope.$defs;
  envelope.properties.batch.items = { type: "object" };

  return {
    schemaId: schema.$id,
    envelope: ajv.compile(envelope),
    event: ajv.compile({ $ref: `${schema.$id}#/$defs/event` }),
  };
}

// Maps an event's validation errors to the protocol reason code. Only the two limits the
// schema expresses get their own code; everything else is schema_invalid.
export function reasonFor(errors: ErrorObject[] | null | undefined): RejectionReason {
  for (const e of errors ?? []) {
    if (e.keyword === "maxProperties" && /\/(properties|traits)$/.test(e.instancePath)) return "properties_too_many";
    if (e.keyword === "maxLength" && /\/(properties|traits)\/[^/]+$/.test(e.instancePath)) return "property_value_too_long";
  }
  return "schema_invalid";
}

export function describeErrors(errors: ErrorObject[] | null | undefined, prefix = ""): string[] {
  return (errors ?? []).map((e) => `${prefix}${e.instancePath || "/"}: ${e.message ?? e.keyword}`);
}
