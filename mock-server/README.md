# mock-server

A small TypeScript stand-in for the ingest service, built in playbook Session 0.2. It exists so every SDK can run the conformance fixtures in CI without the platform.

What it must do:

- POST /v1/batch: decompress gzip when present, validate the body against ../schema/batch.schema.json, record the request (headers, decoded events, received_at) and answer according to the active scenario script (202 with per-event rejections, 400, 401, 413, 429 with Retry-After, 500, 503, or drop the connection).
- POST /__scenario: load a scenario's server script and reset the recording.
- GET /__recorded: return every recorded request in order so a harness can assert the fixture's expectations.
- Ship as a Docker image from CI so sdk-js, sdk-php, sdk-kotlin and sdk-swift pull the same version.

No product logic lives here. If the mock server needs to know something the protocol does not state, the protocol is incomplete.
