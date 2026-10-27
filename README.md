# sdk-spec

The contract between every SDK and the ingest service of the User Monitoring Platform. Nothing in here runs in production; it is what the SDKs and the ingest service are tested against.

- schema/batch.schema.json: JSON Schema (draft 2020-12) for the batch body and the event envelope. The source of truth.
- protocol.md: the wire protocol in words (endpoint, headers, limits, responses, retries, sessions, identity, clock skew).
- fixtures/: conformance scenarios every SDK must pass against the mock server.
- examples/: payloads that validate against the schema (added in Session 0.1).
- mock-server/: a small TypeScript ingest double that validates, records and replays scripted responses (built in Session 0.2).
- VERSION: the spec version. Bump it with every schema or protocol change; SDKs report it in the X-SDK header.

See ../docs/development-plan.md sections 4 and 8 for the reasoning behind every rule.
