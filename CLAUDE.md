# sdk-spec

This repo is the contract between the SDKs (sdk-js, sdk-php, sdk-kotlin, sdk-swift) and the ingest service in platform. The workspace CLAUDE.md one level up holds the settled decisions; ../docs/development-plan.md sections 4 (event model and wire protocol) and 8 (SDK specification) are the design source.

## Rules

- schema/batch.schema.json is the source of truth. Every change to it bumps VERSION and gets a line in CHANGELOG.md.
- protocol.md must be enough for an SDK author to implement a client without reading the server code.
- Fixtures are deterministic: no wall-clock dependence, no randomness. Each scenario states the app actions to drive and the exact requests the mock server must observe.
- The mock server never contains product logic; it validates, records and replays what the scenario file tells it to.
- Examples under examples/ must validate against the schema in CI (npm run validate).

## Commands

- npm install
- npm run validate (ajv against schema and examples)
- cd mock-server && npm test
