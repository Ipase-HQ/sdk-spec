# Wire protocol v1

Status: draft 1.0.0-draft.1. Session 0.1 of the playbook finishes this document; the rules below are the ones already settled in the development plan.

## Endpoint

POST https://in.<domain>/v1/batch

Headers: Authorization: Bearer <write key>; Content-Type: application/json; Content-Encoding: gzip (required above 1 KB, allowed always); X-SDK: <sdk name>/<sdk version>, for example kotlin/1.0.0.

Body: { "sent_at": "<RFC 3339 with offset>", "batch": [ <event>, ... ] } validated by schema/batch.schema.json. At most 500 events or 1 MB compressed per request.

## Responses

| Status | Meaning | SDK behaviour |
| --- | --- | --- |
| 202 | Accepted. Body: { "accepted": n, "rejected": [ { "index": i, "reason": "<code>" } ] } | Remove the batch from the local queue; log rejections |
| 400 | Malformed body (not JSON, not gzip, schema failure on the envelope itself) | Drop the batch; log once |
| 401 | Unknown or revoked write key | Stop sending; log once; retry only after init() with a new key |
| 413 | Batch too large | Split the batch in half and retry both halves |
| 429 | Rate limit or quota exceeded; Retry-After header in seconds | Wait Retry-After, keep the queue intact, then resume |
| 503 | Ingest cannot reach its queue; Retry-After header | Same as 429 |
| other 5xx or no response | Server trouble | Exponential backoff with jitter: 1 s, 2 s, 4 s ... capped at 5 min; keep the queue |

Rejection reason codes: schema_invalid, event_too_large, properties_too_many, property_value_too_long, reserved_name, duplicate_event_id, timestamp_out_of_range.

A batch is retried only on 429, 503, other 5xx and network failure. It is never retried after a 2xx, so duplicates arise only when the server accepted and the response was lost.

## Envelope rules

- event_id is a UUIDv7 minted on the client. The server deduplicates on it eventually (ReplacingMergeTree) and SDKs never reuse one.
- timestamp is the device clock with offset. The server stores received_at and corrects each event by (received_at minus sent_at) when the skew exceeds 5 seconds.
- seq starts at 0 for each session and increments for every event, including lifecycle events.
- properties and traits are flat maps of scalars: at most 100 keys, 64-character keys, 1 KB string values; the server caps an event at 32 KB. Oversized events are rejected individually; the rest of the batch is accepted.
- Names starting with $ are reserved for SDK lifecycle events ($app_installed, $app_updated, $app_backgrounded, $app_foregrounded). A host app call with such a name is rejected locally.

## Sessions

- A session starts on cold launch and on every foreground after the session timeout has elapsed in the background. Defaults: 300 s on mobile, 1800 s on web and desktop; the project can override.
- session_start carries launch_type: cold (process start), warm (process alive, new session after timeout), resume (foreground within the timeout does not start a session and emits $app_foregrounded instead).
- session_end is emitted when the timeout passes, backdated to the last activity, or on process end when the platform allows it. If the process died, the next launch emits the missing session_end before its own session_start.
- Session id, seq and last-activity time are persisted so a process death loses nothing.

## Screens and time on screen

- A screen event carries screen.name, screen.previous (empty on the first screen of a session) and screen.previous_duration_ms (dwell on the previous screen).
- When the app goes to background or the session ends while a screen is visible, the SDK emits screen_exit with screen.duration_ms for that screen.
- The server derives transitions and dwell from these two events alone; no SDK computes aggregates.

## Identity

- device_id is minted on first run, persisted (Keychain, EncryptedSharedPreferences, localStorage) and never derived from hardware or advertising identifiers.
- identify(userId, traits) emits an identify event; every later event carries user_id. reset() clears user_id, keeps device_id and starts a new session.
- Server SDKs send user_id directly and forward the client session id and device id when the request carries X-Session-Id and X-Device-Id headers.

## Queue and flush

- Every event is persisted locally before any network call. Queue capacity 10,000 events; the oldest are dropped beyond that and the drop count is reported as $events_dropped on the next session_start.
- Flush triggers: 30 queued events, 15 s interval, app background, explicit flush(). A batch in flight is marked and cannot be sent twice; it leaves the queue only on 202.

## Privacy

- Never capture text field contents, passwords or keyboard input. Element labels come from ids, accessibility labels or button text truncated to 64 characters.
- Screens on the project denylist emit nothing.
- Consent states: pending (persist locally, send nothing), granted, denied (drop). optOut() takes effect within one flush.
- The SDK never reads or sends the IP address; country is derived at the edge.
