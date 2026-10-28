# mock-server

A small TypeScript stand-in for the ingest service. It exists so every SDK can run the conformance fixtures in CI without the platform. No product logic lives here: it applies the checks protocol.md states, records what it saw, and otherwise replays what the scenario script tells it to. If the mock server needs to know something the protocol does not state, the protocol is incomplete.

Plain node:http plus ajv, no framework. Tests use node:test.

## Run

- npm install
- npm test: type-check and run the suite
- npm run dev: start on http://localhost:8787 (PORT, HOST and SCHEMA_PATH override)
- npm run build, then npm start: run the compiled server from dist/
- From the sdk-spec root: docker build -f mock-server/Dockerfile -t sdk-spec-mock-server . (the image carries schema/, fixtures/ and VERSION; FIXTURES_DIR overrides where POST /__verify reads fixtures)

## CORS

OPTIONS on any path answers 204 with the preflight headers of ../protocol.md section 2.6 (Allow-Origin `*`, Allow-Methods POST, Allow-Headers Authorization, Content-Type, Content-Encoding and X-SDK, Max-Age 7200). A preflight is never recorded and never consumes the script. Every other response carries Access-Control-Allow-Origin `*` and exposes Retry-After, so a browser-like harness such as happy-dom runs with its same-origin checks on.

## POST /v1/batch

What happens, in order. Steps 1 to 5 are real checks and never consume the script.

1. Body over 1 MB on the wire, compressed or not: 413.
2. Content-Encoding: gzip is decompressed. A body that is not gzip, or not JSON: 400 malformed_body.
3. Authorization missing or not `Bearer <key>`: 401. Any key is accepted; a scripted 401 is how a scenario revokes one.
4. More than 500 events: 413.
5. The envelope (sent_at, batch) is validated against ../schema/batch.schema.json: 400 schema_invalid with details.
6. If the script has a response queued it is used and consumed.
7. Otherwise 202. Each event is validated on its own and failures land in rejected while the rest are accepted: schema_invalid, reserved_name, reserved_property_key, properties_too_many and property_value_too_long come from the schema, event_too_large from the 32 KB cap. Scripted rejections are merged in and win on the same index. duplicate_event_id and timestamp_out_of_range are only ever scripted.

Every request is recorded whatever the outcome.

## POST /__scenario

Loads a script and clears the recording. The body is either a whole fixture object from ../fixtures/<id>.json (its id and server.respond are used, the rest is ignored) or { "id": "...", "respond": [ ... ] }. Each entry:

| Field | Meaning |
| --- | --- |
| status | 202, 400, 401, 413, 429, 500 or 503 |
| retry_after | seconds, sent as the Retry-After header on 429 and 503 |
| rejected | for a 202, extra { "index": n, "reason": "..." } entries |
| drop | true closes the connection without answering |
| delay_ms | wait this long before answering |
| repeat | use the entry this many times |

When the script runs out the server answers 202 with real validation. The reply is { "ok": true, "id": ..., "queued": n }, or 400 invalid_script naming the bad entry.

## POST /__verify

{ "fixture": "<id>", "local": { "warnings": [ { "reason", "name" } ] } } evaluates fixtures/<id>.json's expect block against the current recording and the warnings the harness collected, and answers { "pass", "fixture", "platform", "failures": [ { "path", "expected", "actual", "message" } ] }. The fixture comes from the image, not the request. Platform comes from context.sdk.name of the recorded events unless the body passes platform. ../fixtures/README.md is the full contract; src/verify.ts is the only implementation of the matching rules.

## GET /__recorded

{ "scenario": id, "remaining_scripted": n, "requests": [ ... ] } in arrival order. Each request carries index, received_at, method, path, headers (lowercased), compressed, body_bytes, body, events (the decoded batch), errors (why anything was rejected) and response ({ status, headers, body }, or { status: 0, dropped: true }).

DELETE /__recorded clears the recording and keeps the script. GET /__health answers { "ok": true, "spec_version", "schema" } for Docker health checks.

## Layout

- src/schema.ts: compiles the spec schema into an envelope validator and an event validator, maps errors to reason codes
- src/scenario.ts: the script queue and its validation
- src/recorder.ts: the recording
- src/verify.ts: evaluates a fixture's expect block (events with $repeat, $platforms, $session, $label, $same_timestamp_as, $absent and $count, request bounds, every check, forbidden strings, local rejections)
- src/server.ts: createMockServer(), the routes and the batch handler
- src/cli.ts: the entrypoint
- test/server.test.ts: every scripted response, every real rejection, the recording endpoints, and every file in ../examples/valid accepted
- test/verify.test.ts: a passing and a failing recording for every fixture, built by a small deterministic SDK model and posted through POST /v1/batch, plus every matcher and check rule
