#!/usr/bin/env node
// Checks the contract is internally consistent:
//   1. schema/batch.schema.json compiles under JSON Schema draft 2020-12 in strict mode
//   2. every examples/valid/*.json validates
//   3. every examples/invalid/*.json is rejected
//   4. fixtures/scenario.schema.json compiles and every fixtures/*.json scenario validates against it,
//      its id matches its file name, its spec_version matches VERSION, its labels resolve and its
//      per-matcher platforms are a subset of the scenario's platforms
// Exit code 1 on any failure. Run with: npm run validate
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

console.log("fixtures/scenario.schema.json compiles and every scenario validates");
// The scenario schema refers to batch.schema.json for event types, names and launch types; the
// batch schema is already registered under its $id by the compile above.
const validateScenario = ajv.compile(read("fixtures/scenario.schema.json"));
ok("compiled");
const version = readFileSync(join(root, "VERSION"), "utf8").trim();
const fixtures = listJson("fixtures").filter((f) => !f.endsWith(".schema.json"));
if (fixtures.length === 0) fail("no scenario files under fixtures/");
for (const file of fixtures) {
  const scenario = read(file);
  if (!validateScenario(scenario)) {
    fail(`${file}\n        ${ajv.errorsText(validateScenario.errors, { separator: "\n        " })}`);
    continue;
  }
  const problems = crossCheck(scenario, basename(file, ".json"), version);
  if (problems.length) fail(`${file}\n        ${problems.join("\n        ")}`);
  else ok(`${file}  (${scenario.platforms.join(", ")}; ${scenario.steps.length} steps, ${scenario.expect.events.length} matchers)`);
}

function crossCheck(scenario, fileId, specVersion) {
  const problems = [];
  if (scenario.id !== fileId) problems.push(`id is "${scenario.id}" but the file is ${fileId}.json`);
  if (scenario.spec_version !== specVersion) problems.push(`spec_version is ${scenario.spec_version} but VERSION is ${specVersion}`);
  const platforms = new Set(scenario.platforms);
  const labels = new Set();
  scenario.expect.events.forEach((m, i) => {
    for (const p of m.$platforms ?? []) {
      if (!platforms.has(p)) problems.push(`events[${i}] lists platform ${p}, which the scenario does not`);
    }
    if (m.$same_timestamp_as !== undefined && !labels.has(m.$same_timestamp_as)) {
      problems.push(`events[${i}] refers to label "${m.$same_timestamp_as}" before it is defined`);
    }
    if (m.$label !== undefined) {
      if (labels.has(m.$label)) problems.push(`events[${i}] redefines label "${m.$label}"`);
      labels.add(m.$label);
    }
  });
  const mobileOnly = scenario.steps.some((s) => s.action === "kill_process");
  if (mobileOnly && (platforms.has("js") || platforms.has("php"))) {
    problems.push("kill_process is a mobile step; the scenario lists js or php");
  }
  return problems;
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
