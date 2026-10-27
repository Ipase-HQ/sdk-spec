#!/usr/bin/env node
// Checks the contract is internally consistent:
//   1. schema/batch.schema.json compiles under JSON Schema draft 2020-12 in strict mode
//   2. every examples/valid/*.json validates
//   3. every examples/invalid/*.json is rejected
//   4. VERSION matches fixtures/scenarios.json spec_version
// Exit code 1 on any failure. Run with: npm run validate
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const listJson = (dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `${dir}/${f}`);

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const firstError = (errors) => {
  const e = errors[0];
  return `${e.instancePath || "/"} ${e.message}`;
};

console.log("schema/batch.schema.json compiles (draft 2020-12, strict)");
// strictRequired is off: ajv evaluates if/then before properties, so it cannot see that
// the properties the then-branches require are defined on the event. allowUnionTypes is on because
// property values are a scalar union. Every other strict check stays on.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(read("schema/batch.schema.json"));
ok("compiled");

console.log("examples/valid must validate");
for (const file of listJson("examples/valid")) {
  if (validate(read(file))) ok(file);
  else fail(`${file}\n        ${ajv.errorsText(validate.errors, { separator: "\n        " })}`);
}

console.log("examples/invalid must be rejected");
for (const file of listJson("examples/invalid")) {
  if (validate(read(file))) fail(`${file} validated but must not`);
  else ok(`${file}  (${firstError(validate.errors)})`);
}

console.log("VERSION agrees with fixtures/scenarios.json");
const version = readFileSync(join(root, "VERSION"), "utf8").trim();
const scenarios = read("fixtures/scenarios.json");
if (scenarios.spec_version === version) ok(version);
else fail(`VERSION is ${version} but fixtures/scenarios.json says ${scenarios.spec_version}`);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
