# Wire protocol v1

Status: 1.0.0-draft.2.

This document and schema/batch.schema.json are everything an SDK author needs to build a client. The fixtures under fixtures/ are the acceptance test, run against mock-server/. When this document and the schema disagree, the schema wins and this document has a bug. Development plan sections 4 and 8 hold the reasoning; ../docs/adr holds the decisions that go beyond the plan.

Words: "the SDK" is any of kotlin, swift, js and php. "Client SDK" means kotlin, swift and js. "The server" is the ingest service. "Must" is a rule the fixtures test or the server enforces.

## 1. Scope and versioning

- The wire protocol is versioned by the path: /v1. Within /v1 the server only ever adds optional fields. A new required field or a removed field is /v2.
- The contract is versioned by the VERSION file (semver, with draft suffixes before 1.0.0). An SDK is built against one exact VERSION and reports it in context.sdk.spec.
- Every SDK sends X-SDK: `<name>/<version>`, where name is kotlin, swift, js or php and version is the SDK's own semver. The same two values appear in context.sdk.
- The server keeps accepting any SDK version for twelve months after its successor ships.
- The SDK never learns the server's version and never changes behaviour based on it.

## 2. Endpoint, keys and request

### 2.1 Endpoint

POST https://in.<domain>/v1/batch. The host is the `endpoint` option of init(); the default is the production host. SDKs do not follow redirects.

### 2.2 Keys

- Client SDKs authenticate with the project's write key, `wk_live_...` or `wk_test_...`. It ships inside apps and is public. The server protects it with origin and bundle id allowlists, per-key rate limits and anomaly alerts.
- The php SDK authenticates with the project's server key, `sk_live_...`. It is secret and must never be embedded in a client.
- The SDK treats the key as an opaque string. It never parses it beyond logging the prefix.

### 2.3 Headers

| Header | Value | When |
| --- | --- | --- |
| Authorization | `Bearer <key>` | Always |
| Content-Type | `application/json` | Always |
| Content-Encoding | `gzip` | Required when the uncompressed body exceeds 1 KB. Allowed always |
| X-SDK | `<name>/<version>`, for example `kotlin/1.0.0` | Always |

A browser adds Origin on its own. For write keys the server checks Origin against the project's allowed origins and context.app.bundle_id against its allowed bundle ids.

### 2.4 Body

```json
{ "sent_at": "2026-01-15T09:08:00.250Z", "batch": [ { "...": "events, see section 5" } ] }
```

- sent_at is the device clock, RFC 3339 with offset and millisecond precision, read when the request body is built, immediately before sending. Section 16 explains what the server does with it.
- batch holds 1 to 500 events. Nothing else may appear on the envelope.
- The body on the wire is at most 1 MB, compressed or not. The SDK keeps the uncompressed JSON under 1 MB, which guarantees the compressed body fits.
- JSON is UTF-8. A property value that is not a string, a finite number, a boolean or null is refused locally (section 15).

### 2.5 Timeouts

A request that has not completed after 30 seconds is abandoned and counts as a network failure.

## 3. Responses

| Status | Meaning | Body | SDK behaviour |
| --- | --- | --- | --- |
| 202 | Accepted. The server checked every event on its own; some may be rejected | `{ "accepted": n, "rejected": [ { "index": i, "reason": "<code>" } ] }` | Remove every event of the batch from the queue, rejected ones included. Log each rejection once with its index and reason. Reset the backoff counter |
| 400 | Malformed body: not gzip when Content-Encoding says so, not JSON, or the envelope fails the schema | `{ "error": "malformed_body" or "schema_invalid", "message": "...", "details": [ "..." ] }` | Drop the batch. Log once. Reset the backoff counter |
| 401 | The key is unknown, revoked, or not allowed for this origin or bundle id | `{ "error": "invalid_key", "revoked_key", "origin_not_allowed" or "bundle_id_not_allowed", "message": "..." }` | Keep the queue. Stop sending until the next launch. Log once |
| 413 | Batch too large: more than 500 events or more than 1 MB | `{ "error": "batch_too_large", "message": "..." }` | Split the batch in half and send the halves one after the other. A single event that gets 413 is dropped and logged |
| 429 | Rate limit or quota exceeded. Retry-After header in seconds | `{ "error": "rate_limited" or "quota_exceeded", "message": "..." }` | Keep the queue. Send nothing until Retry-After has elapsed (section 4) |
| 503 | Ingest cannot reach its queue. Retry-After header in seconds | `{ "error": "queue_unavailable", "message": "..." }` | Same as 429 |
| Other 5xx, or no response (DNS, TLS, timeout, connection dropped) | Server trouble | Any or none | Keep the queue. Exponential backoff (section 4) |
| Any other status | Misconfiguration | Any | Keep the queue. Stop sending until the next launch. Log once |

Rejection reason codes in a 202 body:

| Code | Meaning |
| --- | --- |
| schema_invalid | The event fails schema/batch.schema.json |
| reserved_name | The name starts with $ and is not on the reserved list (section 7) |
| event_too_large | The serialized event exceeds 32 KB |
| properties_too_many | properties or traits has more than 100 keys |
| property_value_too_long | A string value in properties or traits exceeds 1024 characters |
| duplicate_event_id | The server already accepted this event_id |
| timestamp_out_of_range | After skew correction the event is more than 30 days old or more than 5 minutes in the future |

A rejected event is gone. The SDK does not resend it and the server does not count it toward the quota. Every reason except duplicate_event_id and timestamp_out_of_range is also checked locally before queueing (section 15), so a well-behaved SDK sees them only when the schema and the SDK disagree.

## 4. Retry rules

- A batch is retried only after 429, 503, another 5xx or a network failure. It is never retried after a 2xx, a 400, a 401, a 413 or any other 4xx. A duplicate can therefore only arise when the server accepted a batch and the response was lost; the server deduplicates on event_id.
- Backoff. Retry attempt n, counting from 1, waits `min(300, 2^(n-1))` seconds multiplied by a random factor drawn uniformly from 0.5 to 1.5. That is 1 s, 2 s, 4 s, 8 s and so on up to a 300 s ceiling, each jittered. The counter resets on every response that is not a retry case and on launch.
- Retry-After on 429 and 503 replaces the computed wait exactly, without jitter, and does not advance the counter. A 429 or 503 without Retry-After uses the computed wait.
- A wait freezes sending. While a wait is in progress no trigger sends a request: not the event count, not the timer, not background, not flush(). Events keep queueing. When the wait ends the SDK sends immediately if the queue is not empty.
- One request is in flight at a time per SDK instance. Its events are marked in flight and never included in another batch. On 202 they leave the queue. On any other outcome the mark is cleared and the next attempt builds a fresh batch from the queue, which may now hold newer events. The mark lives in memory only, so a process that dies mid-request resends those events on the next launch.
- On 413 the SDK halves the batch and sends the first half, then the second, each under the normal rules. An event that gets a 413 on its own is dropped with a logged warning.

## 5. The event envelope

Every event is one JSON object with the same shape. The schema is normative; this table is the summary.

| Field | Required | Format | Rule |
| --- | --- | --- | --- |
| event_id | yes | lowercase UUIDv7 | Minted by the SDK when the event is captured: 48 bits of Unix milliseconds, version nibble 7, RFC 9562 variant, 74 random bits. Never reused. The server's deduplication key |
| type | yes | screen, screen_exit, track, identify, session_start, session_end | Section 6 |
| name | track only | 1 to 128 characters | A host app name never starts with $. Names starting with $ are the reserved list (section 7) |
| device_id | yes | lowercase UUID | Section 11 |
| user_id | identify; otherwise when identified | 1 to 128 characters | Present on every event after identify() and absent before it and after reset(). Server-side events set it directly |
| session_id | yes | lowercase UUID | Minted when a session starts. The nil UUID `00000000-0000-0000-0000-000000000000` is allowed only on server-side events without a client session |
| seq | yes | integer 0 to 4294967295 | Per session, starting at 0, incremented for every event the session queues, lifecycle events included. Persisted with the session. Server-side events always carry 0 |
| timestamp | yes | RFC 3339 with offset | Device clock at capture, millisecond precision |
| screen | screen, screen_exit | object | Section 10 |
| element | $tap; optional on other track events | object | id or label is required. Section 14 |
| properties | optional on screen and track | flat map | At most 100 keys of 1 to 64 characters; string values at most 1024 characters; values are string, number, boolean or null |
| traits | optional on identify | flat map | Same limits as properties |
| launch_type | session_start | cold, warm, resume | Section 9 |
| duration_ms | session_end | integer | Section 6 |
| screens_viewed | session_end | integer | Section 6 |
| events_count | session_end | integer | Section 6 |
| context | yes | object | Section 8 |

Fields that belong to another type are rejected: a track with launch_type, a screen with name, traits outside identify. The serialized event, context included, must stay under 32 KB.

Which fields each type carries:

| Field | screen | screen_exit | track | identify | session_start | session_end |
| --- | --- | --- | --- | --- | --- | --- |
| name | no | no | required | no | no | no |
| screen | required | required, with duration_ms | no | no | no | no |
| element | no | no | required on $tap, else optional | no | no | no |
| properties | optional | no | optional | no | no | no |
| traits | no | no | no | optional | no | no |
| launch_type | no | no | no | no | required | no |
| duration_ms, screens_viewed, events_count | no | no | no | no | no | required |
| user_id | when identified | when identified | when identified | required | when identified | when identified |

## 6. Event types

### screen

Emitted when a screen becomes visible, through auto-capture (section 14) or screen(name, properties). screen.name is the screen; screen.route is the path or navigation route when the platform has one. screen.previous and screen.previous_duration_ms describe the screen before it (section 10). properties come from the screen() call.

### screen_exit

Emitted when the visible screen stops being visible for one of these reasons: the app goes to the background, the session ends (timeout, reset(), or a launch that closes a dead session), or a denylisted screen replaces it. screen.duration_ms is the time the screen was visible since it was shown or since the last foreground, whichever is later. Never emitted for a denylisted screen. Carries no properties.

### track

Emitted by track(name, properties) and by the SDK itself under a reserved name (section 7). element is required on $tap and allowed on any track event that an auto-capture or a host app wants to attach a control to.

### identify

Emitted by identify(userId, traits). user_id is required; traits are optional and the server merges them into the user's profile. From this event on, every event carries user_id until reset().

### session_start

Emitted when a session starts (section 9). launch_type says why.

### session_end

Emitted when a session ends (section 9). Its fields are computed by the SDK:

- timestamp: the moment the session ended. For a session ended by the timeout or by process death this is the last activity: the timestamp of the last event queued in that session before session_end. For reset() it is the moment of the call.
- duration_ms: timestamp minus the session_start timestamp.
- screens_viewed: the number of screen events in the session.
- events_count: the number of events in the session including session_end itself, which equals the session_end seq plus one.

## 7. Reserved names

Track events the SDK emits on its own use a name starting with $. The list is closed; the schema rejects any other $ name and the server answers reserved_name. A host app that passes a $ name to track() is refused locally (section 15).

| Name | Emitted when | properties |
| --- | --- | --- |
| $app_installed | On the first session_start after the device id was minted (the first run on this device or browser). Client SDKs only | none |
| $app_updated | On the first session_start after context.app.version differs from the persisted value. Not on the first run | previous_version, version |
| $app_backgrounded | The app goes to the background. Android: no activity visible (ProcessLifecycleOwner ON_STOP). iOS: didEnterBackground. Web and desktop: the document becomes hidden or pagehide fires. After the screen_exit of the visible screen | none |
| $app_foregrounded | The app returns to the foreground, or a launch continues a live session, within the session timeout | none |
| $tap | Auto-capture saw a tap or click on a control. element is required (section 14) | none |
| $events_dropped | After a session_start, when the persisted dropped counter is above zero (section 12). The counter resets to zero once the event is queued | count: the number dropped |

Order of the events a session start produces: session_start, then $app_installed or $app_updated if either applies, then $events_dropped if it applies, then the entry screen if one is visible (section 9). Order on background: screen_exit, then $app_backgrounded.

## 8. Context

context is collected once per launch and attached to every event unchanged. network may be refreshed when the platform reports a change.

| Field | Required | Source |
| --- | --- | --- |
| platform | yes | android, ios, web, desktop or server. The js SDK reports web in a browser and desktop under Electron |
| app.name | yes | Android: the application label. iOS: CFBundleDisplayName, else CFBundleName. Web, desktop and server: the `appName` init option |
| app.version | yes | Android: versionName. iOS: CFBundleShortVersionString. Electron: app.getVersion(). Web and server: the `appVersion` init option |
| app.build | no | Android: versionCode. iOS: CFBundleVersion |
| app.bundle_id | all platforms except server | Android: the package name. iOS: the bundle identifier. Web: location.origin. Desktop: the `bundleId` init option. The server checks it against the project's allowlist |
| os.name | yes | Android, iOS, iPadOS, macOS, Windows, Linux, ChromeOS, or unknown on the web when the user agent does not say. Server: PHP_OS_FAMILY |
| os.version | yes | Android: Build.VERSION.RELEASE. iOS: systemVersion. Web: parsed from the user agent, unknown if absent. Server: php_uname("r") |
| device.model | no | Android: Build.MODEL. iOS: the utsname machine string, for example iPhone17,1. Web: Mac, iPhone, iPad, Android, Windows PC or unknown |
| device.manufacturer | no | Android: Build.MANUFACTURER. iOS: Apple |
| device.screen | no | Width x height of the screen in points, for example 393x852. Web: the viewport |
| browser.name, browser.version | js only | Chrome, Safari, Firefox, Edge, Samsung Internet, Opera or unknown, with the version from the user agent. Electron reports Electron and its version |
| locale | yes | The system's BCP 47 tag, for example en-GB |
| timezone | yes | The system's IANA zone name, for example Europe/London |
| network | no | wifi, cellular, ethernet, offline or unknown. Omitted by the php SDK |
| sdk.name, sdk.version, sdk.spec | yes | The SDK name and version from the X-SDK header, and the VERSION the SDK was built against |

## 9. Sessions

### 9.1 Persisted state

The client SDK persists, in storage that survives process death: device_id, the current session (session_id, started_at, seq, last_activity, screens_viewed), user_id, the visible screen (name, route, shown_at, whether it is denylisted), dropped_count, the last seen app.version, the consent state and the event queue. A write happens before the SDK returns from any call that changes the state. last_activity is the timestamp of the last event queued in the session.

### 9.2 Timeout

session_timeout_seconds is the `sessionTimeout` init option. Defaults: 300 on android and ios, 1800 on web and desktop. The host app passes the project's value; the SDK does not fetch configuration. The timeout counts time in the background only. A session never ends while the app is in the foreground, however idle.

### 9.3 Launch

A launch is a process start on mobile and desktop, and a page load on the web. After init():

1. If a persisted session exists and now minus last_activity is within the timeout, the session continues. The SDK emits $app_foregrounded and restarts the dwell timer of the visible screen. No session_start.
2. Otherwise, if a persisted session exists, it is closed first: screen_exit for the visible screen if one was visible and no screen_exit was emitted for it at background, then session_end. Both are backdated to last_activity, and screen_exit.duration_ms is last_activity minus shown_at or the last foreground.
3. Then a new session starts with launch_type cold: new session_id, seq 0, session_start, then $app_installed on the first run or $app_updated when the version changed, then $events_dropped if dropped_count is above zero.

The php SDK has no sessions and emits none of this.

### 9.4 Background and foreground

- Background: screen_exit for the visible screen if it is not denylisted, then $app_backgrounded, then a flush (section 12). The SDK records when the app went to the background.
- Foreground within the timeout: $app_foregrounded. The dwell timer of the visible screen restarts. No screen event, unless the screen that becomes visible is a different one, in which case it is a normal screen event whose previous is the screen that was visible at background with previous_duration_ms equal to its visible time since foreground, which is zero.
- Foreground after the timeout: session_end for the old session backdated to last_activity (no screen_exit, one was emitted at background), then session_start with launch_type resume, then $events_dropped if it applies, then a screen event for the visible screen with no previous, if a screen is visible.

### 9.5 reset()

reset() ends the session and starts a new one while the app stays in the foreground: screen_exit for the visible screen if one is visible, session_end carrying the user_id that was set, then user_id is cleared, then session_start with launch_type warm and no user_id, then a screen event for the visible screen with no previous. device_id does not change.

### 9.6 launch_type

| Value | Meaning |
| --- | --- |
| cold | A launch with no live persisted session: process start on mobile and desktop, page load on the web |
| warm | A new session started while the app is in the foreground. Today only reset() does this |
| resume | The app returned to the foreground after the session timeout |

## 10. Screens and dwell

- The visible screen is the one that most recently became visible. A denylisted screen is visible but silent.
- Dwell is visible time only. It runs from the moment a screen is shown, or from the last foreground, whichever is later, and stops at background, at a screen change and at session end.
- A screen event carries previous and previous_duration_ms when a non-denylisted screen was visible immediately before it in the same session. previous_duration_ms is that screen's dwell. No previous on the first screen of a session, on the entry screen after a resume or warm session_start, and on the first screen after a denylisted one.
- When a denylisted screen replaces a visible screen, the replaced screen gets a screen_exit. While a denylisted screen is visible the SDK emits no screen event, no screen_exit and no $tap. Explicit track(), identify() and screen() calls still work, except that screen() with a denylisted name emits nothing. The denylist matches the screen name exactly.
- route is the path without query string or fragment on the web, and the navigation route pattern on Compose. Query strings never leave the device.
- The server derives transitions and dwell from screen and screen_exit alone. No SDK computes aggregates.

## 11. Identity

### 11.1 device_id

A lowercase UUIDv4 minted on the first run and persisted. Never a hardware id, an advertising id or anything derived from one. Storage: EncryptedSharedPreferences excluded from backup on Android, a file in the app's Application Support directory on iOS, localStorage mirrored in IndexedDB on the web, the app's user data directory on desktop. The id does not survive an uninstall; a reinstall is a new device and emits $app_installed again. Client SDKs expose the id through `deviceId()` so a host app can forward it to its own backend.

### 11.2 identify and reset

identify(userId, traits) emits an identify event and persists user_id. Every later event carries it, across sessions, until reset(). Calling identify() again with a different user id emits a new identify event and replaces the persisted id without starting a session. reset() is described in section 9.5.

### 11.3 Server-side events

The php SDK runs inside the tenant's backend and has no sessions or screens of its own.

- user_id comes from the call.
- When the incoming HTTP request carries X-Session-Id and X-Device-Id, the SDK forwards their values as session_id and device_id. A value that is not a lowercase UUID is ignored. Client SDKs expose `sessionId()` and `deviceId()` so the host app can set those headers on its API calls.
- Without X-Session-Id, session_id is the nil UUID. Without X-Device-Id, device_id is a UUIDv4 the server SDK minted once and persisted (for example in the application's cache store), so one backend is one device.
- seq is 0 on every server-side event, forwarded session or not. The server cannot know the client's counter, and seq orders events from one SDK instance only; the dashboard places server-side events by timestamp.
- context.platform is server and app.bundle_id is absent.

## 12. Queue, batching and flush

- Persist first. Every event is written to durable storage on a background thread before any network activity. track() and friends return immediately. Storage: SQLite on Android and iOS, IndexedDB with a localStorage fallback on the web, the Laravel queue in php.
- Capacity: 10,000 events. When full, the oldest event that is not in flight is dropped and dropped_count is incremented and persisted. The count is reported as $events_dropped (section 7).
- Triggers: 30 queued events (`flushAt`), every 15 seconds while the queue is not empty (`flushInterval`), the app going to the background, explicit flush(), and the end of a retry wait. Not launch. The php SDK uses 100 events and 5 seconds.
- Batch assembly: queue order, which is seq order within a session and insertion order across sessions. At most 500 events, and the SDK stops adding events before the serialized body would exceed 1 MB. Events from different sessions may share a batch.
- One request in flight at a time, as in section 4.
- Background flush: Android hands the request to WorkManager and iOS to a background URLSession configuration so it completes after the app is suspended. The web uses fetch with keepalive on visibilitychange and pagehide and keeps those bodies under 64 KB by sending smaller batches; sendBeacon is not used because it cannot carry the Authorization header.
- Consent (the `consent` init option, default granted, persisted): pending queues events and sends nothing; granted is normal operation; denied drops every event, clears the queue and counts nothing. optIn() sets granted, optOut() sets denied, and either takes effect before the next flush.

## 13. Privacy

- The SDK never captures the contents of a text field, text area, password field, search field or any keyboard input, on any platform. Taps on such controls emit nothing.
- element.label comes from an accessibility label, a content description or visible button text, truncated to 64 characters. Never from a text input's value or placeholder.
- The SDK never reads or sends the IP address; the server derives the country at the edge and stores no IP.
- No hardware or advertising identifiers, ever.
- Routes carry the path only. Query strings and fragments never leave the device.
- Denylisted screens are silent (section 10).
- Properties and traits are the host app's data. The SDK does not inspect them beyond the limits in section 15.

## 14. Auto-capture

Enabled by the `autocapture` init option, `{ screens: true, taps: true }` by default on client SDKs. Manual screen() and track() always work and can be used alongside.

| Platform | Screens | Taps |
| --- | --- | --- |
| android | Activity resume and Fragment resume (class simple name), NavController destination changes (route, else label) | A Window.Callback wrapper sees touch up on a clickable view. element.id is the resource entry name, element.label the contentDescription or text of a TextView, element.type the view class simple name |
| ios | viewDidAppear through swizzling (class name without the ViewController suffix), SwiftUI through the .monitorScreen("Name") modifier | UIControl.sendAction and UITapGestureRecognizer through swizzling. element.id is accessibilityIdentifier, element.label the accessibilityLabel or titleLabel text, element.type the class name |
| web and desktop | The initial load and every History API pushState, replaceState and popstate. screen.name is the pathname with numeric and UUID segments replaced by :id, screen.route is the pathname | Delegated click on button, a, input of type button or submit, and any element with role=button. element.id is data-monitor-id, else the id attribute; element.label the aria-label, else the trimmed text content; element.type the lowercase tag name |
| server | none | none |

A $tap is emitted only when element.id or element.label is available. element.screen is the visible screen's name whenever there is one.

## 15. Local validation

The SDK refuses these before queueing and logs one warning per refusal naming the event and the reason. Nothing is truncated silently. The fixtures observe the warnings through a log hook the SDK exposes for tests.

| Reason | Rule |
| --- | --- |
| invalid_name | An event or screen name that is empty or longer than 128 characters |
| reserved_name | A host app name starting with $ |
| invalid_user_id | A user id that is empty or longer than 128 characters |
| properties_too_many | More than 100 keys in properties or traits |
| property_key_too_long | A key that is empty or longer than 64 characters |
| property_value_too_long | A string value longer than 1024 characters |
| invalid_property | A value that is not a string, a finite number, a boolean or null |
| event_too_large | The serialized event, context included, exceeds 32 KB |

## 16. Clock skew

- timestamp and sent_at come from the same device clock. The SDK never adjusts timestamps and never consults a time server.
- The server records received_at for every event and computes skew as received_at minus sent_at per batch. When the absolute skew exceeds 5 seconds, every event in the batch is stored with timestamp plus skew; otherwise the timestamp is stored as sent. received_at is always kept.
- After correction, an event more than 30 days old or more than 5 minutes in the future is rejected with timestamp_out_of_range.
- seq, not the clock, orders events within a session.

## 17. Public API

init(writeKey, options) with options endpoint, appName, appVersion, bundleId (desktop), flushInterval (15 s), flushAt (30), maxQueue (10,000), sessionTimeout (section 9.2), autocapture (section 14), consent (section 12), denylistScreens (section 10). Then screen(name, properties), track(name, properties), identify(userId, traits), reset(), optIn(), optOut(), flush(), deviceId(), sessionId(). The php SDK exposes track, identify and flush through a Laravel facade and reads the forwarding headers from the current request.

For the conformance harness every SDK also takes an injectable clock and scheduler, and a log hook that reports local refusals.

## 18. Conformance

An SDK is correct when every fixture under fixtures/ that lists its platform passes against the mock server. fixtures/README.md describes the harness, the steps and the matching rules; mock-server/README.md describes the server. CI in each SDK repository pulls the mock server image published by this repository and runs the fixtures at the VERSION the SDK was built against.
