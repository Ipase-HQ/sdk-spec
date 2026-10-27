// The mock ingest server. No product logic: it applies the checks protocol.md states,
// records what it saw, and otherwise answers whatever the loaded scenario script says.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { Recorder, type RecordedResponse } from "./recorder.js";
import { parseScript, Scenario, type Rejection, type ScriptedResponse } from "./scenario.js";
import { DEFAULT_SCHEMA_PATH, DEFAULT_VERSION_PATH, describeErrors, loadValidators, reasonFor, type Validators } from "./schema.js";

export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB on the wire, compressed or not
export const MAX_EVENT_BYTES = 32 * 1024; // 32 KB per serialized event

export interface MockServerOptions {
  schemaPath?: string;
  versionPath?: string;
  log?: (line: string) => void;
}

export type MockServer = Server & { scenario: Scenario; recorder: Recorder };

interface Context {
  validators: Validators;
  specVersion: string;
  scenario: Scenario;
  recorder: Recorder;
  log: (line: string) => void;
}

export function createMockServer(options: MockServerOptions = {}): MockServer {
  const ctx: Context = {
    validators: loadValidators(options.schemaPath ?? DEFAULT_SCHEMA_PATH),
    specVersion: readFileSync(options.versionPath ?? DEFAULT_VERSION_PATH, "utf8").trim(),
    scenario: new Scenario(),
    recorder: new Recorder(),
    log: options.log ?? (() => {}),
  };
  const server = createServer((req, res) => {
    route(req, res, ctx).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`error: ${message}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal_error", message });
    });
  });
  return Object.assign(server, { scenario: ctx.scenario, recorder: ctx.recorder });
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://mock");
  const method = req.method ?? "GET";

  if (method === "POST" && pathname === "/v1/batch") return handleBatch(req, res, ctx);
  if (method === "POST" && pathname === "/__scenario") return handleScenario(req, res, ctx);
  if (method === "GET" && pathname === "/__recorded") {
    return sendJson(res, 200, { scenario: ctx.scenario.id, remaining_scripted: ctx.scenario.remaining, requests: ctx.recorder.all() });
  }
  if (method === "DELETE" && pathname === "/__recorded") {
    ctx.recorder.reset();
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && pathname === "/__health") {
    return sendJson(res, 200, { ok: true, spec_version: ctx.specVersion, schema: ctx.validators.schemaId });
  }
  sendJson(res, 404, { error: "not_found" });
}

async function handleBatch(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const raw = await readBody(req);
  const headers = flattenHeaders(req);
  const compressed = /\bgzip\b/i.test(headers["content-encoding"] ?? "");
  const errors: string[] = [];
  let body: unknown = null;
  let events: unknown[] = [];

  const record = (response: RecordedResponse) =>
    ctx.recorder.add({
      received_at: new Date().toISOString(),
      method: "POST",
      path: "/v1/batch",
      headers,
      compressed,
      body_bytes: raw.length,
      body,
      events,
      errors,
      response,
    });
  const reply = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}) => {
    record({ status, headers: extraHeaders, body: payload });
    sendJson(res, status, payload, extraHeaders);
    ctx.log(`POST /v1/batch -> ${status} (${events.length} events${errors.length ? `, ${errors.length} error(s)` : ""})`);
  };
  const fail = (status: number, error: string, message: string, details?: string[]) => {
    errors.push(...(details ?? [message]));
    reply(status, details ? { error, message, details } : { error, message });
  };

  // Real checks, in the order a client would hit them. None of these consume the script.
  if (raw.length > MAX_BODY_BYTES) {
    return fail(413, "batch_too_large", `body is ${raw.length} bytes, limit ${MAX_BODY_BYTES}`);
  }
  let text: string;
  if (compressed) {
    try {
      text = gunzipSync(raw).toString("utf8");
    } catch {
      return fail(400, "malformed_body", "Content-Encoding is gzip but the body is not valid gzip");
    }
  } else {
    text = raw.toString("utf8");
  }
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "malformed_body", "body is not valid JSON");
  }
  if (body && typeof body === "object" && Array.isArray((body as { batch?: unknown }).batch)) {
    events = (body as { batch: unknown[] }).batch;
  }
  if (!/^Bearer\s+\S+$/.test(headers.authorization ?? "")) {
    return fail(401, "unauthorized", "Authorization header must be 'Bearer <write key>'");
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return fail(413, "batch_too_large", `batch has ${events.length} events, limit ${MAX_EVENTS_PER_BATCH}`);
  }
  if (!ctx.validators.envelope(body)) {
    return fail(400, "schema_invalid", "the batch envelope does not match the schema", describeErrors(ctx.validators.envelope.errors));
  }

  // Scripted response, if the scenario has one queued.
  const scripted = ctx.scenario.next();
  if (scripted?.delay_ms) await sleep(scripted.delay_ms);
  if (scripted?.drop) {
    record({ status: 0, dropped: true });
    ctx.log(`POST /v1/batch -> connection dropped (${events.length} events)`);
    req.socket.destroy();
    return;
  }
  const status = scripted?.status ?? 202;
  const extraHeaders: Record<string, string> = {};
  if ((status === 429 || status === 503) && scripted?.retry_after !== undefined) {
    extraHeaders["retry-after"] = String(scripted.retry_after);
  }
  if (status !== 202) return reply(status, scriptedErrorBody(status), extraHeaders);

  // 202: every event is checked on its own; the rest of the batch is accepted.
  const rejected = new Map<number, Rejection>();
  for (const r of rejectEvents(events, ctx.validators, errors)) rejected.set(r.index, r);
  for (const r of scripted?.rejected ?? []) rejected.set(r.index, r);
  const rejectedList = [...rejected.values()].sort((a, b) => a.index - b.index);
  reply(202, { accepted: events.length - rejectedList.length, rejected: rejectedList }, extraHeaders);
}

function rejectEvents(events: unknown[], validators: Validators, errors: string[]): Rejection[] {
  const out: Rejection[] = [];
  events.forEach((event, index) => {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_EVENT_BYTES) {
      out.push({ index, reason: "event_too_large" });
      errors.push(`/batch/${index}: event is ${bytes} bytes, limit ${MAX_EVENT_BYTES}`);
      return;
    }
    if (!validators.event(event)) {
      out.push({ index, reason: reasonFor(validators.event.errors) });
      errors.push(...describeErrors(validators.event.errors, `/batch/${index}`));
    }
  });
  return out;
}

function scriptedErrorBody(status: number): { error: string } {
  switch (status) {
    case 400:
      return { error: "malformed_body" };
    case 401:
      return { error: "unauthorized" };
    case 413:
      return { error: "batch_too_large" };
    case 429:
      return { error: "rate_limited" };
    case 503:
      return { error: "queue_unavailable" };
    default:
      return { error: "internal_error" };
  }
}

async function handleScenario(req: IncomingMessage, res: ServerResponse, ctx: Context): Promise<void> {
  const raw = await readBody(req);
  let body: { id?: unknown; respond?: unknown; server?: { respond?: unknown } };
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    return sendJson(res, 400, { error: "malformed_body", message: "scenario must be JSON" });
  }
  let script: ScriptedResponse[];
  try {
    script = parseScript(body?.server?.respond ?? body?.respond ?? []);
  } catch (err) {
    return sendJson(res, 400, { error: "invalid_script", message: (err as Error).message });
  }
  const id = typeof body?.id === "string" ? body.id : null;
  ctx.scenario.load(id, script);
  ctx.recorder.reset();
  ctx.log(`scenario ${id ?? "(unnamed)"} loaded, ${ctx.scenario.remaining} scripted response(s), recording cleared`);
  sendJson(res, 200, { ok: true, id, queued: ctx.scenario.remaining });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(payload));
}
