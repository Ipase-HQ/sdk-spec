# Examples

Payloads for the batch endpoint. Every file under valid/ must validate against ../schema/batch.schema.json and every file under invalid/ must be rejected; npm run validate checks both and CI runs it. The mock server's tests also post every valid example and expect a 202 with nothing rejected.

These files are generated. Edit ../scripts/generate-examples.mjs and run npm run examples; do not edit the JSON by hand. Event ids are UUIDv7 with the event's own timestamp in the first 48 bits.

## valid/

| File | What it shows |
| --- | --- |
| mobile-session.json | A whole Android session: cold start, $app_installed, two screens, an auto-captured $tap with element details, a manual track, then background (screen_exit before $app_backgrounded) and a session_end backdated to the last activity. |
| web-identify-and-reset.json | Web session with routes and browser context: events before identify carry only device_id, events after carry user_id too; reset() exits the visible screen, ends the session, and starts a warm session without user_id that re-enters the visible screen. |
| server-php.json | A server-side event from the PHP SDK inside a client session: user_id set directly, device_id and session_id forwarded from the X-Device-Id and X-Session-Id request headers, seq 0, every scalar type in properties. |
| server-php-no-session.json | Server-side events with no client session to attach to (a queued job): the nil session id, a device id the server SDK minted once and persisted, seq 0 on every event, an identify with traits. |
| lifecycle-events.json | The reserved $ names on iOS in their required order: session_start, $app_updated, then $events_dropped reporting a queue overflow from the previous run; later $app_backgrounded with the matching screen_exit before it, and $app_foregrounded within the timeout so the session continues. |
| resume-after-timeout.json | Foreground after the session timeout: the old session's session_end is backdated to its last activity (the $app_backgrounded event), the new session starts with launch_type resume and re-enters the visible screen with no previous. No $app_installed because this is not the first run. |
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
| reserved-name-from-host-app.json | a name starting with $ must be on the reserved list |
| tap-without-element.json | $tap requires element |
| element-without-id-or-label.json | element needs id or label |
| events-dropped-without-count.json | $events_dropped requires properties.count |
| track-with-launch-type.json | launch_type belongs to session_start only |
| track-with-traits.json | traits belong to identify only |
| screen-without-screen-object.json | screen requires the screen object |
| screen-with-name.json | a screen event carries no name (the screen name is screen.name) |
| screen-with-own-duration.json | screen.duration_ms belongs to screen_exit only |
| previous-without-duration.json | screen.previous and screen.previous_duration_ms come together |
| screen-exit-without-duration.json | screen_exit requires screen.duration_ms |
| identify-without-user-id.json | identify requires user_id |
| session-start-without-launch-type.json | session_start requires launch_type |
| bad-launch-type.json | launch_type must be cold, warm or resume |
| session-end-without-duration.json | session_end requires duration_ms |
| session-end-without-counts.json | session_end requires screens_viewed and events_count |
| negative-seq.json | seq starts at 0 |
| non-integer-seq.json | seq is an integer |
| seq-over-uint32.json | seq fits in 32 bits |
| bad-timestamp.json | timestamp is RFC 3339 date-time |
| bad-event-id.json | event_id is a UUID |
| uppercase-event-id.json | event_id is lowercase |
| uuid-v4-event-id.json | event_id is version 7 |
| bad-device-id.json | device_id is a lowercase UUID |
| bad-session-id.json | session_id is a lowercase UUID |
| nested-property.json | property values are scalars, not objects |
| array-property.json | property values are scalars, not arrays |
| too-many-properties.json | at most 100 property keys (this one has 101) |
| property-key-too-long.json | property keys are at most 64 characters |
| property-value-too-long.json | string values are at most 1024 characters |
| missing-platform.json | context.platform is required |
| unknown-platform.json | context.platform is android, ios, web, desktop or server |
| web-without-bundle-id.json | every platform except server sends app.bundle_id |
| missing-sdk-spec.json | context.sdk.spec is required |
| unknown-sdk-name.json | context.sdk.name is kotlin, swift, js or php |
| unknown-network.json | context.network is wifi, cellular, ethernet, offline or unknown |
| bad-device-screen.json | context.device.screen is width x height in points |
