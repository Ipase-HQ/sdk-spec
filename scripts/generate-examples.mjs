#!/usr/bin/env node
// Writes examples/valid/*.json, examples/invalid/*.json and examples/README.md.
// Edit this file, not the generated JSON, then run: npm run examples
// Everything here is deterministic: fixed timestamps, event ids derived from a counter.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "examples");
const SPEC = readFileSync(join(root, "VERSION"), "utf8").trim();

// UUIDv7 with the real timestamp in the first 48 bits and deterministic filler after the version nibble.
let counter = 0;
function v7(iso) {
  counter += 1;
  const t = Date.parse(iso).toString(16).padStart(12, "0");
  const rand = ((BigInt(counter) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffffn).toString(16).padStart(18, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
}

const ORDER = [
  "event_id", "type", "name", "device_id", "user_id", "session_id", "seq", "timestamp",
  "launch_type", "screen", "element", "properties", "traits",
  "duration_ms", "screens_viewed", "events_count", "context",
];
function event(fields) {
  const ordered = {};
  for (const key of ORDER) if (fields[key] !== undefined) ordered[key] = fields[key];
  return ordered;
}
// Returns an emitter bound to one session: seq counts up from 0 on every call.
function session(context, deviceId, sessionId) {
  let seq = 0;
  return (timestamp, type, fields = {}) =>
    event({ event_id: v7(timestamp), type, device_id: deviceId, session_id: sessionId, seq: seq++, timestamp, context, ...fields });
}
// Server SDKs never count: seq is 0 on every event.
function serverEmitter(context, deviceId, sessionId) {
  return (timestamp, type, fields = {}) =>
    event({ event_id: v7(timestamp), type, device_id: deviceId, session_id: sessionId, seq: 0, timestamp, context, ...fields });
}
const batch = (sent_at, events) => ({ sent_at, batch: events });

const KOTLIN = {
  platform: "android",
  app: { name: "Mango", version: "3.4.1", build: "341", bundle_id: "com.mangoentertainment.app" },
  os: { name: "Android", version: "16" },
  device: { model: "Pixel 9", manufacturer: "Google", screen: "412x915" },
  locale: "en-GB",
  timezone: "Europe/London",
  network: "wifi",
  sdk: { name: "kotlin", version: "1.0.0", spec: SPEC },
};
const SWIFT = {
  platform: "ios",
  app: { name: "Mango", version: "3.4.0", build: "2026.1.9", bundle_id: "com.mangoentertainment.ios" },
  os: { name: "iOS", version: "26.2" },
  device: { model: "iPhone17,1", manufacturer: "Apple", screen: "393x852" },
  locale: "en-US",
  timezone: "America/New_York",
  network: "cellular",
  sdk: { name: "swift", version: "1.0.0", spec: SPEC },
};
const JS = {
  platform: "web",
  app: { name: "Mango Web", version: "2026.01.12", bundle_id: "https://app.mangoentertainment.com" },
  os: { name: "macOS", version: "15.3" },
  device: { model: "Mac", screen: "1512x982" },
  browser: { name: "Chrome", version: "131.0.6778.86" },
  locale: "de-DE",
  timezone: "Europe/Berlin",
  network: "wifi",
  sdk: { name: "js", version: "1.0.0", spec: SPEC },
};
const PHP = {
  platform: "server",
  app: { name: "mango-backend", version: "2026.01.10" },
  os: { name: "Linux", version: "6.8" },
  locale: "en",
  timezone: "UTC",
  sdk: { name: "php", version: "1.0.0", spec: SPEC },
};
const MINIMAL_CONTEXT = {
  platform: "android",
  app: { name: "Mango", version: "3.4.1", bundle_id: "com.mangoentertainment.app" },
  os: { name: "Android", version: "16" },
  locale: "en-GB",
  timezone: "Europe/London",
  sdk: { name: "kotlin", version: "1.0.0", spec: SPEC },
};

const DEVICE_A = "6f1d0a52-3b7e-4c9a-8e21-5d4f7a9b0c3e";
const DEVICE_WEB = "a4c1e8d2-9b3f-4e6a-b7c5-2d8f0a1b3c4d";
const DEVICE_IOS = "c9e8d7c6-b5a4-4f3e-9d2c-1b0a9f8e7d6c";
const DEVICE_SERVER = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const SESSION_A = "3f1c2b4e-8a6d-4e2f-9b7c-1a2b3c4d5e6f";
const NIL_SESSION = "00000000-0000-0000-0000-000000000000";

const valid = {};

{
  const e = session(KOTLIN, DEVICE_A, SESSION_A);
  valid["mobile-session.json"] = {
    shows: "A whole Android session: cold start, $app_installed, two screens, an auto-captured $tap with element details, a manual track, then background (screen_exit before $app_backgrounded) and a session_end backdated to the last activity.",
    payload: batch("2026-01-15T09:08:00.250Z", [
      e("2026-01-15T09:00:00.000Z", "session_start", { launch_type: "cold" }),
      e("2026-01-15T09:00:00.050Z", "track", { name: "$app_installed" }),
      e("2026-01-15T09:00:01.000Z", "screen", { screen: { name: "Feed" } }),
      e("2026-01-15T09:00:12.400Z", "track", {
        name: "$tap",
        element: { id: "like_button", label: "Like", type: "ImageButton", screen: "Feed" },
      }),
      e("2026-01-15T09:00:12.420Z", "track", { name: "like", properties: { post_id: "p_8812", source: "feed" } }),
      e("2026-01-15T09:01:00.000Z", "screen", { screen: { name: "Profile", previous: "Feed", previous_duration_ms: 59000 } }),
      e("2026-01-15T09:03:00.000Z", "screen_exit", { screen: { name: "Profile", duration_ms: 120000 } }),
      e("2026-01-15T09:03:00.000Z", "track", { name: "$app_backgrounded" }),
      e("2026-01-15T09:03:00.000Z", "session_end", { duration_ms: 180000, screens_viewed: 2, events_count: 9 }),
    ]),
  };
}

{
  const a = session(JS, DEVICE_WEB, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
  const b = session(JS, DEVICE_WEB, "9b2f5c1d-3e4a-4b6c-8d7e-2f1a0b9c8d7e");
  valid["web-identify-and-reset.json"] = {
    shows: "Web session with routes and browser context: events before identify carry only device_id, events after carry user_id too; reset() exits the visible screen, ends the session, and starts a warm session without user_id that re-enters the visible screen.",
    payload: batch("2026-01-15T10:20:15.000+01:00", [
      a("2026-01-15T10:15:00.000+01:00", "session_start", { launch_type: "cold" }),
      a("2026-01-15T10:15:00.030+01:00", "track", { name: "$app_installed" }),
      a("2026-01-15T10:15:00.120+01:00", "screen", { screen: { name: "Home", route: "/" } }),
      a("2026-01-15T10:15:42.000+01:00", "track", { name: "browse", properties: { category: "shoes" } }),
      a("2026-01-15T10:16:05.000+01:00", "identify", { user_id: "u_123", traits: { plan: "free", signup_month: "2025-11" } }),
      a("2026-01-15T10:17:10.000+01:00", "screen", { user_id: "u_123", screen: { name: "Checkout", route: "/checkout", previous: "Home", previous_duration_ms: 129880 } }),
      a("2026-01-15T10:18:30.000+01:00", "track", {
        name: "$tap",
        user_id: "u_123",
        element: { id: "pay-now", label: "Pay now", type: "button", screen: "Checkout" },
      }),
      a("2026-01-15T10:18:30.900+01:00", "track", {
        name: "purchase",
        user_id: "u_123",
        properties: { order_id: "o_55", value: 49.99, currency: "EUR", items: 2 },
      }),
      a("2026-01-15T10:19:00.000+01:00", "screen_exit", { user_id: "u_123", screen: { name: "Checkout", duration_ms: 110000 } }),
      a("2026-01-15T10:19:00.000+01:00", "session_end", { user_id: "u_123", duration_ms: 240000, screens_viewed: 2, events_count: 10 }),
      b("2026-01-15T10:19:00.000+01:00", "session_start", { launch_type: "warm" }),
      b("2026-01-15T10:19:00.000+01:00", "screen", { screen: { name: "Checkout", route: "/checkout" } }),
      b("2026-01-15T10:19:20.000+01:00", "track", { name: "browse", properties: { category: "hats" } }),
    ]),
  };
}

{
  const p = serverEmitter(PHP, DEVICE_A, SESSION_A);
  valid["server-php.json"] = {
    shows: "A server-side event from the PHP SDK inside a client session: user_id set directly, device_id and session_id forwarded from the X-Device-Id and X-Session-Id request headers, seq 0, every scalar type in properties.",
    payload: batch("2026-01-15T09:00:05.000+00:00", [
      p("2026-01-15T09:00:04.870+00:00", "track", {
        name: "order_shipped",
        user_id: "u_123",
        properties: { order_id: "o_55", carrier: "dhl", express: false, weight_kg: 1.2, gift_note: null },
      }),
    ]),
  };
}

{
  const p = serverEmitter(PHP, DEVICE_SERVER, NIL_SESSION);
  valid["server-php-no-session.json"] = {
    shows: "Server-side events with no client session to attach to (a queued job): the nil session id, a device id the server SDK minted once and persisted, seq 0 on every event, an identify with traits.",
    payload: batch("2026-01-15T02:00:00.400+00:00", [
      p("2026-01-15T02:00:00.100+00:00", "identify", { user_id: "u_123", traits: { plan: "pro", renewal_month: "2026-02" } }),
      p("2026-01-15T02:00:00.250+00:00", "track", { name: "subscription_renewed", user_id: "u_123", properties: { plan: "pro", amount: 9.99, currency: "EUR" } }),
    ]),
  };
}

{
  const s = session(SWIFT, DEVICE_IOS, "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f");
  valid["lifecycle-events.json"] = {
    shows: "The reserved $ names on iOS in their required order: session_start, $app_updated, then $events_dropped reporting a queue overflow from the previous run; later $app_backgrounded with the matching screen_exit before it, and $app_foregrounded within the timeout so the session continues.",
    payload: batch("2026-01-15T07:32:00.000-05:00", [
      s("2026-01-15T07:30:00.000-05:00", "session_start", { launch_type: "cold" }),
      s("2026-01-15T07:30:00.040-05:00", "track", { name: "$app_updated", properties: { previous_version: "3.3.2", version: "3.4.0" } }),
      s("2026-01-15T07:30:00.045-05:00", "track", { name: "$events_dropped", properties: { count: 12 } }),
      s("2026-01-15T07:30:01.000-05:00", "screen", { screen: { name: "Home" } }),
      s("2026-01-15T07:31:00.000-05:00", "screen_exit", { screen: { name: "Home", duration_ms: 59000 } }),
      s("2026-01-15T07:31:00.000-05:00", "track", { name: "$app_backgrounded" }),
      s("2026-01-15T07:31:45.000-05:00", "track", { name: "$app_foregrounded" }),
    ]),
  };
}

{
  const old = session(KOTLIN, DEVICE_A, "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d");
  const fresh = session(KOTLIN, DEVICE_A, "0f1e2d3c-4b5a-4968-8776-655443322110");
  valid["resume-after-timeout.json"] = {
    shows: "Foreground after the session timeout: the old session's session_end is backdated to its last activity (the $app_backgrounded event), the new session starts with launch_type resume and re-enters the visible screen with no previous. No $app_installed because this is not the first run.",
    payload: batch("2026-01-15T12:06:01.000Z", [
      old("2026-01-15T12:00:00.000Z", "session_start", { launch_type: "cold" }),
      old("2026-01-15T12:00:00.800Z", "screen", { screen: { name: "Feed" } }),
      old("2026-01-15T12:00:30.800Z", "screen_exit", { screen: { name: "Feed", duration_ms: 30000 } }),
      old("2026-01-15T12:00:30.800Z", "track", { name: "$app_backgrounded" }),
      old("2026-01-15T12:00:30.800Z", "session_end", { duration_ms: 30800, screens_viewed: 1, events_count: 5 }),
      fresh("2026-01-15T12:06:00.000Z", "session_start", { launch_type: "resume" }),
      fresh("2026-01-15T12:06:00.000Z", "screen", { screen: { name: "Feed" } }),
    ]),
  };
}

{
  const m = session(MINIMAL_CONTEXT, DEVICE_A, SESSION_A);
  valid["minimal.json"] = {
    shows: "The smallest valid batch: one track event with only the required fields and the required context.",
    payload: batch("2026-01-15T09:00:01.000Z", [m("2026-01-15T09:00:00.000Z", "track", { name: "button_tap" })]),
  };
}

{
  const properties = {};
  for (let i = 1; i <= 98; i += 1) {
    const key = `p${String(i).padStart(3, "0")}`;
    properties[key] = i % 4 === 0 ? i : i % 4 === 1 ? `v${i}` : i % 4 === 2 ? i % 8 === 2 : null;
  }
  properties["k".repeat(64)] = "longest allowed key";
  properties.longest_allowed_value = "x".repeat(1024);
  const m = session(KOTLIN, DEVICE_A, SESSION_A);
  valid["max-properties.json"] = {
    shows: "The limits exactly: 100 property keys, one key of 64 characters, one string value of 1024 characters, every scalar type. Still well under the 32 KB per-event cap.",
    payload: batch("2026-01-15T09:00:01.000Z", [m("2026-01-15T09:00:00.000Z", "track", { name: "catalog_filter", properties })]),
  };
}

// Each invalid example is minimal.json with exactly one thing wrong.
const minimal = () => structuredClone(valid["minimal.json"].payload);
const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
const retype = (b, type) => {
  b.batch[0].type = type;
  delete b.batch[0].name;
};
const invalid = {
  "empty-batch.json": { breaks: "batch must have at least one event", mutate: (b) => { b.batch = []; } },
  "missing-sent-at.json": { breaks: "sent_at is required", mutate: (b) => { delete b.sent_at; } },
  "unknown-envelope-field.json": { breaks: "no extra keys on the envelope (the SDK name belongs in the X-SDK header)", mutate: (b) => { b.sdk = "kotlin/1.0.0"; } },
  "unknown-event-field.json": { breaks: "no extra keys on an event (and never an IP address)", mutate: (b) => { b.batch[0].ip = "203.0.113.7"; } },
  "missing-context.json": { breaks: "context is required", mutate: (b) => { delete b.batch[0].context; } },
  "bad-event-type.json": { breaks: "type must be one of the six event types", mutate: (b) => { b.batch[0].type = "pageview"; } },
  "track-without-name.json": { breaks: "track requires name", mutate: (b) => { delete b.batch[0].name; } },
  "reserved-name-from-host-app.json": { breaks: "a name starting with $ must be on the reserved list", mutate: (b) => { b.batch[0].name = "$checkout"; } },
  "tap-without-element.json": { breaks: "$tap requires element", mutate: (b) => { b.batch[0].name = "$tap"; } },
  "element-without-id-or-label.json": { breaks: "element needs id or label", mutate: (b) => { b.batch[0].name = "$tap"; b.batch[0].element = { type: "button" }; } },
  "events-dropped-without-count.json": { breaks: "$events_dropped requires properties.count", mutate: (b) => { b.batch[0].name = "$events_dropped"; b.batch[0].properties = { reason: "overflow" }; } },
  "track-with-launch-type.json": { breaks: "launch_type belongs to session_start only", mutate: (b) => { b.batch[0].launch_type = "cold"; } },
  "track-with-traits.json": { breaks: "traits belong to identify only", mutate: (b) => { b.batch[0].traits = { plan: "free" }; } },
  "screen-without-screen-object.json": { breaks: "screen requires the screen object", mutate: (b) => { retype(b, "screen"); } },
  "screen-with-name.json": { breaks: "a screen event carries no name (the screen name is screen.name)", mutate: (b) => { b.batch[0].type = "screen"; b.batch[0].screen = { name: "Feed" }; } },
  "screen-with-own-duration.json": { breaks: "screen.duration_ms belongs to screen_exit only", mutate: (b) => { retype(b, "screen"); b.batch[0].screen = { name: "Feed", duration_ms: 1000 }; } },
  "previous-without-duration.json": { breaks: "screen.previous and screen.previous_duration_ms come together", mutate: (b) => { retype(b, "screen"); b.batch[0].screen = { name: "Feed", previous: "Home" }; } },
  "screen-exit-without-duration.json": { breaks: "screen_exit requires screen.duration_ms", mutate: (b) => { retype(b, "screen_exit"); b.batch[0].screen = { name: "Feed" }; } },
  "identify-without-user-id.json": { breaks: "identify requires user_id", mutate: (b) => { retype(b, "identify"); b.batch[0].traits = { plan: "free" }; } },
  "session-start-without-launch-type.json": { breaks: "session_start requires launch_type", mutate: (b) => { retype(b, "session_start"); } },
  "bad-launch-type.json": { breaks: "launch_type must be cold, warm or resume", mutate: (b) => { retype(b, "session_start"); b.batch[0].launch_type = "hot"; } },
  "session-end-without-duration.json": { breaks: "session_end requires duration_ms", mutate: (b) => { retype(b, "session_end"); b.batch[0].screens_viewed = 1; b.batch[0].events_count = 1; } },
  "session-end-without-counts.json": { breaks: "session_end requires screens_viewed and events_count", mutate: (b) => { retype(b, "session_end"); b.batch[0].duration_ms = 1000; } },
  "negative-seq.json": { breaks: "seq starts at 0", mutate: (b) => { b.batch[0].seq = -1; } },
  "non-integer-seq.json": { breaks: "seq is an integer", mutate: (b) => { b.batch[0].seq = 1.5; } },
  "seq-over-uint32.json": { breaks: "seq fits in 32 bits", mutate: (b) => { b.batch[0].seq = 4294967296; } },
  "bad-timestamp.json": { breaks: "timestamp is RFC 3339 date-time", mutate: (b) => { b.batch[0].timestamp = "yesterday"; } },
  "bad-event-id.json": { breaks: "event_id is a UUID", mutate: (b) => { b.batch[0].event_id = "evt_1"; } },
  "uppercase-event-id.json": { breaks: "event_id is lowercase", mutate: (b) => { b.batch[0].event_id = b.batch[0].event_id.toUpperCase(); } },
  "uuid-v4-event-id.json": { breaks: "event_id is version 7", mutate: (b) => { b.batch[0].event_id = "3f1c2b4e-8a6d-4e2f-9b7c-1a2b3c4d5e6f"; } },
  "bad-device-id.json": { breaks: "device_id is a lowercase UUID", mutate: (b) => { b.batch[0].device_id = "d_7f3a9c1e5b2d4a6f"; } },
  "bad-session-id.json": { breaks: "session_id is a lowercase UUID", mutate: (b) => { b.batch[0].session_id = "session-1"; } },
  "nested-property.json": { breaks: "property values are scalars, not objects", mutate: (b) => { b.batch[0].properties = { cart: { items: 2 } }; } },
  "array-property.json": { breaks: "property values are scalars, not arrays", mutate: (b) => { b.batch[0].properties = { tags: ["a", "b"] }; } },
  "too-many-properties.json": { breaks: "at most 100 property keys (this one has 101)", mutate: (b) => { b.batch[0].properties = keys(101); } },
  "property-key-too-long.json": { breaks: "property keys are at most 64 characters", mutate: (b) => { b.batch[0].properties = { ["k".repeat(65)]: 1 }; } },
  "reserved-property-key.json": { breaks: "property and trait keys never start with $", mutate: (b) => { b.batch[0].properties = { $plan: "pro" }; } },
  "property-value-too-long.json": { breaks: "string values are at most 1024 characters", mutate: (b) => { b.batch[0].properties = { note: "x".repeat(1025) }; } },
  "missing-platform.json": { breaks: "context.platform is required", mutate: (b) => { delete b.batch[0].context.platform; } },
  "unknown-platform.json": { breaks: "context.platform is android, ios, web, desktop or server", mutate: (b) => { b.batch[0].context.platform = "watch"; } },
  "web-without-bundle-id.json": { breaks: "every platform except server sends app.bundle_id", mutate: (b) => { b.batch[0].context.platform = "web"; delete b.batch[0].context.app.bundle_id; } },
  "missing-sdk-spec.json": { breaks: "context.sdk.spec is required", mutate: (b) => { delete b.batch[0].context.sdk.spec; } },
  "unknown-sdk-name.json": { breaks: "context.sdk.name is kotlin, swift, js or php", mutate: (b) => { b.batch[0].context.sdk.name = "flutter"; } },
  "unknown-network.json": { breaks: "context.network is wifi, cellular, ethernet, offline or unknown", mutate: (b) => { b.batch[0].context.network = "satellite"; } },
  "bad-device-screen.json": { breaks: "context.device.screen is width x height in points", mutate: (b) => { b.batch[0].context.device = { screen: "large" }; } },
};

for (const dir of ["valid", "invalid"]) {
  rmSync(join(out, dir), { recursive: true, force: true });
  mkdirSync(join(out, dir), { recursive: true });
}
const write = (path, data) => writeFileSync(join(out, path), `${JSON.stringify(data, null, 2)}\n`);
for (const [file, { payload }] of Object.entries(valid)) write(`valid/${file}`, payload);
for (const [file, { mutate }] of Object.entries(invalid)) {
  const payload = minimal();
  mutate(payload);
  write(`invalid/${file}`, payload);
}

const row = (file, text) => `| ${file} | ${text} |`;
const readme = `# Examples

Payloads for the batch endpoint. Every file under valid/ must validate against ../schema/batch.schema.json and every file under invalid/ must be rejected; npm run validate checks both and CI runs it. The mock server's tests also post every valid example and expect a 202 with nothing rejected.

These files are generated. Edit ../scripts/generate-examples.mjs and run npm run examples; do not edit the JSON by hand. Event ids are UUIDv7 with the event's own timestamp in the first 48 bits.

## valid/

| File | What it shows |
| --- | --- |
${Object.entries(valid).map(([file, { shows }]) => row(file, shows)).join("\n")}

## invalid/

Each file is minimal.json with exactly one thing wrong, so the first validation error names the rule.

| File | What breaks |
| --- | --- |
${Object.entries(invalid).map(([file, { breaks }]) => row(file, breaks)).join("\n")}
`;
writeFileSync(join(out, "README.md"), readme);

const count = (dir) => readdirSync(join(out, dir)).filter((f) => f.endsWith(".json")).length;
console.log(`wrote ${count("valid")} valid and ${count("invalid")} invalid examples to ${out}`);
