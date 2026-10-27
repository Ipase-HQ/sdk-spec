# Conformance fixtures

One JSON file per scenario, validated by scenario.schema.json (npm run validate from the repository root). Each file lists the app actions a test harness drives and the exact events the mock server must observe. An SDK is published only when every scenario that lists its platform passes in CI against the mock server. The scenarios are the seven from docs/development-plan.md section 8; the rules they exercise are in ../protocol.md.

| File | Platforms | Proves |
| --- | --- | --- |
| offline-then-online.json | kotlin, swift, js | Nothing is lost or duplicated across an offline period; the queue drains in one batch |
| process-kill.json | kotlin, swift | Persisted events survive a kill; the dead session is closed on the next launch, backdated |
| backoff-429.json | all | Retry-After is honoured even on explicit flush; the retried batch carries the same events |
| session-timeout.json | kotlin, swift, js | One second under the timeout keeps the session, one second over ends it with launch_type resume |
| identity-stitching.json | kotlin, swift, js | user_id appears after identify and disappears after reset; device_id never changes |
| privacy.json | kotlin, swift, js | Typed text never leaves the device; $tap carries the element; denylisted screens emit nothing |
| property-limits.json | all | 101 keys and a host-app $ name are refused locally with a warning; 100 keys go through |

## Running a scenario

Each SDK repository has a harness that, for every fixture listing its platform:

1. Starts from a fresh install: no persisted device id, session, queue or consent state.
2. Starts the mock server (or uses the Docker image) and posts the whole fixture object to POST /__scenario. That loads `server.respond` and clears the recording.
3. Initialises the SDK with the mock server as endpoint, a test write key (or server key for php) and the options in `config`. Anything not in `config` keeps the protocol default.
4. Drives `steps` in order. Steps take no time unless the step is wait_ms.
5. Reads GET /__recorded and evaluates `expect`.

### Time

Fixtures are deterministic. The harness owns the clock: wait_ms advances the SDK's clock and fires any timer that falls due, it does not sleep. Every SDK therefore takes an injectable clock and scheduler (the production default is the real one). A harness may instead sleep for real; the expectations hold either way because nothing asserts wall-clock gaps.

### Steps

| action | Fields | What the harness does |
| --- | --- | --- |
| launch | | Process start or page load, then init(). Session rules in protocol.md decide what the SDK emits |
| network | state: offline or online | Makes the SDK's transport fail (offline) or reach the mock server (online). Offline attempts never reach the server |
| screen | name | Shows a screen with that name. Through auto-capture where the platform has it, otherwise screen(name) |
| track | name, properties or property_count, repeat | Calls track(). property_count n generates keys k0 to k(n-1) with integer values. repeat calls it n times |
| tap | element_id, label, repeat | Taps or clicks a control whose id (resource id, accessibilityIdentifier, data-monitor-id) and visible text are given, so auto-capture sees it |
| type_text | field, value | Types value into the named text field |
| identify | user_id, traits | Calls identify() |
| reset | | Calls reset() |
| background, foreground | | Moves the app to the background (hidden tab on the web) or back |
| kill_process | | Kills the process without any callback. Mobile only |
| wait_ms | value | Advances the clock by value milliseconds |
| flush | | Calls flush() and waits until the SDK has no request in flight |
| assert_requests | count | Reads GET /__recorded and asserts exactly count requests so far, any status |

### expect

- `events`: the exact ordered list of events in every request the server answered 202, concatenated in arrival order. Requests with any other status contribute nothing here. A matcher must match the next event in the stream or the scenario fails; events left over at the end fail it too. Listed fields must deep-equal the event's fields; objects are compared key by key, so unlisted keys are free. `{"$absent": true}` means the field must be missing. In properties and traits, `$count` fixes the number of keys. Keys starting with $ steer the matcher: `$repeat` consumes that many consecutive events; `$platforms` applies the matcher on those platforms only and skips it elsewhere; `$session` labels a session (same label, same session_id; different labels, different session_ids); `$label` names the event (the last one under `$repeat`) and `$same_timestamp_as` asserts equal timestamps with the named event.
- `requests`: min and max for the number of requests recorded, any status.
- `checks`, over the same 202 stream:
  - event_ids_unique: no event_id appears twice.
  - seq_contiguous_per_session: within each session_id, seq runs 0, 1, 2 ... in arrival order. On php every event carries seq 0, which is what the check verifies there.
  - device_id_constant: every event carries the same device_id.
  - session_end_consistent: for every session_end, duration_ms equals its timestamp minus the session_start timestamp, events_count equals its seq plus one, and screens_viewed equals the number of screen events in that session.
  - rejected_requests_resent: the event_ids of every request not answered 202 all appear in a later request.
- `payload_never_contains`: strings that must not occur anywhere in any recorded body, decoded. Checked on every request whatever its status.
- `local_rejections`: events the SDK must refuse before queueing, in order, each with a warning the harness can observe (a log hook or listener the SDK exposes for tests).

### Writing a new scenario

Copy the closest file, keep `spec_version` equal to VERSION and `id` equal to the file name, and run npm run validate. The schema refuses unknown step actions, unknown matcher fields, event types, launch types and reserved names the wire schema does not know, and label references that point nowhere. Add a line to CHANGELOG.md.
