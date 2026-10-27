# Examples

Payloads for the batch endpoint. Every file under valid/ must validate against ../schema/batch.schema.json and every file under invalid/ must be rejected; npm run validate checks both and CI runs it. The mock server's tests also post every valid example and expect a 202 with nothing rejected.

These files are generated. Edit ../scripts/generate-examples.mjs and run npm run examples; do not edit the JSON by hand. Event ids are UUIDv7 with the event's own timestamp in the first 48 bits.

## valid/

| File | What it shows |
| --- | --- |
| mobile-session.json | A whole Android session: cold start, $app_installed, two screens, a tap with element details, background, screen_exit and a session_end backdated to the last activity. |
| web-identify-and-reset.json | Web session with routes: events before identify carry only device_id, events after carry user_id too, reset ends the session and starts a new one without user_id. |
| server-php.json | A server-side event from the PHP SDK: user_id set directly, device_id and session_id forwarded from the X-Device-Id and X-Session-Id request headers, every scalar type in properties. |
| lifecycle-events.json | The reserved $ lifecycle names on iOS: $app_updated after a cold start, $app_backgrounded with the matching screen_exit, $app_foregrounded within the timeout so the session continues. |
| minimal.json | The smallest valid batch: one track event with only the required fields and the required context. |
| max-properties.json | The limits exactly: 100 property keys, one key of 64 characters, one string value of 1024 characters, every scalar type. Still well under the 32 KB per-event cap. |

## invalid/

Each file is minimal.json with exactly one thing wrong, so the first validation error names the rule.

| File | What breaks |
| --- | --- |
| empty-batch.json | batch must have at least one event |
| missing-sent-at.json | sent_at is required |
| unknown-envelope-field.json | no extra keys on the envelope (the SDK name belongs in the X-SDK header) |
| unknown-event-field.json | no extra keys on an event (and never an IP address) |
| missing-context.json | context is required |
| bad-event-type.json | type must be one of the six event types |
| track-without-name.json | track requires name |
| screen-without-screen-object.json | screen requires the screen object |
| identify-without-user-id.json | identify requires user_id |
| session-start-without-launch-type.json | session_start requires launch_type |
| session-end-without-duration.json | session_end requires duration_ms |
| bad-launch-type.json | launch_type must be cold, warm or resume |
| negative-seq.json | seq starts at 0 |
| non-integer-seq.json | seq is an integer |
| bad-timestamp.json | timestamp is RFC 3339 date-time |
| bad-event-id.json | event_id is a UUID |
| short-device-id.json | device_id is at least 8 characters |
| nested-property.json | property values are scalars, not objects |
| array-property.json | property values are scalars, not arrays |
| too-many-properties.json | at most 100 property keys (this one has 101) |
| property-key-too-long.json | property keys are at most 64 characters |
| property-value-too-long.json | string values are at most 1024 characters |
| unknown-sdk-name.json | context.sdk.name is kotlin, swift, js or php |
| unknown-network.json | context.network is wifi, cellular, ethernet, offline or unknown |
