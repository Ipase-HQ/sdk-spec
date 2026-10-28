// POST /__verify against every fixture: a recording that conforms passes, and a recording with one
// defect fails with failures that name the expectation, the expected and actual values, and where
// in the recording it went wrong. Recordings are built by a small deterministic model of an SDK and
// posted through the real POST /v1/batch, so scripted responses and real validation both apply.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createMockServer, type MockServer } from "../src/server.js";

type Event = Record<string, any>;
type Warning = { reason: string; name: string };
type Platform = "kotlin" | "swift" | "js" | "php";

const fixturesDir = new URL("../../fixtures/", import.meta.url);
const fixture = (id: string): any => JSON.parse(readFileSync(new URL(`${id}.json`, fixturesDir), "utf8"));
const SPEC = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
const NIL = "00000000-0000-0000-0000-000000000000";

// ---- a deterministic SDK model -------------------------------------------------------------

let counter = 0;
const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
function v7(ms: number): string {
  const t = hex(ms, 12);
  const r = hex(++counter, 18);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${r.slice(0, 3)}-8${r.slice(3, 6)}-${r.slice(6, 18)}`;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${hex(n, 12)}`;

const CONTEXTS: Record<Platform, Event> = {
  js: {
    platform: "web",
    app: { name: "Mango", version: "1.0.0", bundle_id: "https://app.example.com" },
    os: { name: "macOS", version: "15.1" },
    browser: { name: "Chrome", version: "130" },
    locale: "en-GB",
    timezone: "Europe/London",
    sdk: { name: "js", version: "0.1.0", spec: SPEC },
  },
  kotlin: {
    platform: "android",
    app: { name: "Mango", version: "1.0.0", bundle_id: "com.mango.app" },
    os: { name: "Android", version: "15" },
    locale: "en-GB",
    timezone: "Europe/London",
    sdk: { name: "kotlin", version: "0.1.0", spec: SPEC },
  },
  swift: {
    platform: "ios",
    app: { name: "Mango", version: "1.0.0", bundle_id: "com.mango.app" },
    os: { name: "iOS", version: "18.1" },
    locale: "en-GB",
    timezone: "Europe/London",
    sdk: { name: "swift", version: "0.1.0", spec: SPEC },
  },
  php: {
    platform: "server",
    app: { name: "Mango API", version: "1.0.0" },
    os: { name: "Linux", version: "6.8" },
    locale: "en-GB",
    timezone: "Europe/London",
    sdk: { name: "php", version: "0.1.0", spec: SPEC },
  },
};

class Device {
  readonly deviceId = uuid(++counter);
  clock = Date.parse("2026-10-28T10:00:00.000Z");
  userId: string | undefined;
  private session: { id: string; seq: number; start: number; screens: number } | null = null;
  private queue: Event[] = [];

  constructor(readonly platform: Platform) {}

  private emit(fields: Event, ts = this.clock): Event {
    const s = this.session;
    const event: Event = {
      event_id: v7(ts),
      ...fields,
      device_id: this.deviceId,
      session_id: s ? s.id : NIL,
      seq: s ? s.seq++ : 0,
      timestamp: new Date(ts).toISOString(),
      context: structuredClone(CONTEXTS[this.platform]),
    };
    if (this.userId !== undefined && event.user_id === undefined) event.user_id = this.userId;
    if (fields.type === "screen" && s) s.screens += 1;
    this.queue.push(event);
    if (ts === this.clock) this.clock += 1000;
    return event;
  }

  start(launch_type: "cold" | "warm" | "resume"): Event {
    this.session = { id: uuid(++counter), seq: 0, start: this.clock, screens: 0 };
    return this.emit({ type: "session_start", launch_type });
  }
  end(at: number): Event {
    const s = this.session!;
    const event = this.emit({ type: "session_end", duration_ms: at - s.start, screens_viewed: s.screens, events_count: s.seq + 1 }, at);
    this.session = null;
    return event;
  }
  track(name: string, extra: Event = {}): Event {
    return this.emit({ type: "track", name, ...extra });
  }
  screen(name: string): Event {
    return this.emit({ type: "screen", screen: { name } });
  }
  screenExit(name: string, duration_ms: number, at = this.clock): Event {
    return this.emit({ type: "screen_exit", screen: { name, duration_ms } }, at);
  }
  identify(userId: string, traits: Event): Event {
    this.userId = userId;
    return this.emit({ type: "identify", user_id: userId, traits });
  }
  drain(): Event[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}

const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

interface Recording {
  platform: Platform;
  batches: Event[][];
  warnings: Warning[];
}

// What a conforming SDK sends for each fixture. Each batch is one POST /v1/batch.
const conforming: Record<string, (p: Platform) => Recording> = {
  "offline-then-online": (platform) => {
    const d = new Device(platform);
    d.start("cold");
    d.track("$app_installed");
    for (let i = 0; i < 50; i++) d.track("button_tap");
    return { platform, batches: [d.drain()], warnings: [] };
  },
  "process-kill": (platform) => {
    const d = new Device(platform);
    d.start("cold");
    d.track("$app_installed");
    const feed = d.screen("Feed");
    for (let i = 0; i < 4; i++) d.track("like");
    const last = d.track("like");
    const lastTs = Date.parse(last.timestamp);
    d.screenExit("Feed", lastTs - Date.parse(feed.timestamp), lastTs);
    d.end(lastTs);
    d.clock += 400_000;
    d.start("cold");
    return { platform, batches: [d.drain()], warnings: [] };
  },
  "backoff-429": (platform) => {
    const d = new Device(platform);
    if (platform !== "php") {
      d.start("cold");
      d.track("$app_installed");
    }
    for (let i = 0; i < 3; i++) d.track("button_tap");
    const batch = d.drain();
    return { platform, batches: [batch, structuredClone(batch)], warnings: [] };
  },
  "session-timeout": (platform) => {
    const d = new Device(platform);
    d.start("cold");
    d.track("$app_installed");
    d.track("$app_backgrounded");
    const first = d.drain();
    d.clock += 299_000;
    d.track("$app_foregrounded");
    const lastBackground = d.track("$app_backgrounded");
    const second = d.drain();
    d.clock += 301_000;
    d.end(Date.parse(lastBackground.timestamp));
    d.start("resume");
    return { platform, batches: [first, second, d.drain()], warnings: [] };
  },
  "identity-stitching": (platform) => {
    const d = new Device(platform);
    d.start("cold");
    d.track("$app_installed");
    d.track("browse");
    d.identify("u_123", { plan: "free" });
    const purchase = d.track("purchase");
    d.end(Date.parse(purchase.timestamp));
    d.userId = undefined;
    d.start("warm");
    d.track("browse");
    return { platform, batches: [d.drain()], warnings: [] };
  },
  privacy: (platform) => {
    const d = new Device(platform);
    d.start("cold");
    d.track("$app_installed");
    const login = d.screen("Login");
    d.track("$tap", { element: { id: "login_button", label: "Sign in", type: "button", screen: "Login" } });
    d.screenExit("Login", d.clock - Date.parse(login.timestamp));
    return { platform, batches: [d.drain()], warnings: [] };
  },
  "property-limits": (platform) => {
    const d = new Device(platform);
    if (platform !== "php") {
      d.start("cold");
      d.track("$app_installed");
    }
    d.track("fine", { properties: keys(100) });
    return {
      platform,
      batches: [d.drain()],
      warnings: [
        { reason: "properties_too_many", name: "too_many" },
        { reason: "reserved_name", name: "$checkout" },
        { reason: "reserved_property_key", name: "upgrade" },
      ],
    };
  },
};

// ---- HTTP ----------------------------------------------------------------------------------

let server: MockServer;
let base: string;

before(async () => {
  server = createMockServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function postJson(path: string, body: unknown, auth = false): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = "Bearer wk_test_0123456789abcdef";
  const res = await fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

/** Loads the fixture, posts each batch, then asks /__verify. Returns the verdict. */
async function run(id: string, rec: Recording, opts: { loadAs?: unknown; platform?: string } = {}): Promise<any> {
  const loaded = await postJson("/__scenario", opts.loadAs ?? fixture(id));
  assert.equal(loaded.status, 200);
  for (const batch of rec.batches) {
    const r = await postJson("/v1/batch", { sent_at: batch.at(-1)?.timestamp ?? new Date().toISOString(), batch }, true);
    if (r.status === 202) assert.deepEqual(r.json.rejected, [], `the model sent an event the schema rejects: ${JSON.stringify(r.json)}`);
  }
  const verdict = await postJson("/__verify", { fixture: id, local: { warnings: rec.warnings }, ...(opts.platform ? { platform: opts.platform } : {}) });
  assert.equal(verdict.status, 200, JSON.stringify(verdict.json));
  return verdict.json;
}

const paths = (verdict: any) => verdict.failures.map((f: any) => f.path).sort();
const failureAt = (verdict: any, path: string) => verdict.failures.find((f: any) => f.path === path);
const passes = (verdict: any) => assert.deepEqual({ pass: verdict.pass, failures: verdict.failures }, { pass: true, failures: [] });

// ---- every fixture: one pass, one fail -------------------------------------------------------

describe("POST /__verify, a passing and a failing recording per fixture", () => {
  it("offline-then-online passes on js", async () => {
    const verdict = await run("offline-then-online", conforming["offline-then-online"]("js"));
    passes(verdict);
    assert.equal(verdict.platform, "js");
    assert.equal(verdict.fixture, "offline-then-online");
  });

  it("offline-then-online fails when a queued event is sent twice", async () => {
    const rec = conforming["offline-then-online"]("js");
    rec.batches[0].push(structuredClone(rec.batches[0].at(-1)!));
    const verdict = await run("offline-then-online", rec);
    assert.equal(verdict.pass, false);
    // The duplicate also repeats its seq, so the seq check catches it too.
    assert.deepEqual(paths(verdict), ["expect.checks.event_ids_unique", "expect.checks.seq_contiguous_per_session", "expect.events"]);
    assert.match(failureAt(verdict, "expect.checks.event_ids_unique").message, /stream position 52 \(request 0, batch index 52\) was already accepted at stream position 51/);
    assert.match(failureAt(verdict, "expect.events").message, /1 event\(s\) no matcher accounts for, starting at stream position 52.*track button_tap/);
  });

  it("process-kill passes on kotlin", async () => {
    passes(await run("process-kill", conforming["process-kill"]("kotlin")));
  });

  it("process-kill fails when the dead session's screen_exit is not backdated", async () => {
    const rec = conforming["process-kill"]("kotlin");
    const exit = rec.batches[0].find((e) => e.type === "screen_exit")!;
    const lastLike = exit.timestamp;
    exit.timestamp = new Date(Date.parse(exit.timestamp) + 400_000).toISOString();
    const verdict = await run("process-kill", rec);
    assert.deepEqual(paths(verdict), ["expect.events[4].$same_timestamp_as"]);
    const f = failureAt(verdict, "expect.events[4].$same_timestamp_as");
    assert.equal(f.expected, lastLike);
    assert.equal(f.actual, exit.timestamp);
    assert.match(f.message, /stream position 8 .* must equal that of "last_like" at stream position 7/);
  });

  it("backoff-429 passes on js and on php", async () => {
    passes(await run("backoff-429", conforming["backoff-429"]("js")));
    const php = await run("backoff-429", conforming["backoff-429"]("php"));
    passes(php);
    assert.equal(php.platform, "php");
  });

  it("backoff-429 fails when the retried batch does not carry the same events", async () => {
    const rec = conforming["backoff-429"]("js");
    const retried = rec.batches[1].at(-1)!;
    retried.event_id = v7(Date.parse(retried.timestamp));
    const verdict = await run("backoff-429", rec);
    assert.deepEqual(paths(verdict), ["expect.checks.rejected_requests_resent"]);
    const f = failureAt(verdict, "expect.checks.rejected_requests_resent");
    assert.deepEqual(f.actual, [rec.batches[0].at(-1)!.event_id]);
    assert.match(f.message, /request 0 got 429, but 1 of its event_ids never appear in a later request/);
  });

  it("session-timeout passes on swift", async () => {
    passes(await run("session-timeout", conforming["session-timeout"]("swift")));
  });

  it("session-timeout fails when the new session starts warm instead of resume", async () => {
    const rec = conforming["session-timeout"]("swift");
    rec.batches[2].at(-1)!.launch_type = "warm";
    const verdict = await run("session-timeout", rec);
    assert.deepEqual(paths(verdict), ["expect.events[6]", "expect.events[6].launch_type"]);
    const f = failureAt(verdict, "expect.events[6].launch_type");
    assert.deepEqual([f.expected, f.actual], ["resume", "warm"]);
    assert.match(f.message, /launch_type is "warm", expected "resume" at stream position 6 \(request 2, batch index 1\), a session_start/);
  });

  it("identity-stitching passes on js", async () => {
    passes(await run("identity-stitching", conforming["identity-stitching"]("js")));
  });

  it("identity-stitching fails when user_id survives reset()", async () => {
    const rec = conforming["identity-stitching"]("js");
    rec.batches[0].at(-1)!.user_id = "u_123";
    const verdict = await run("identity-stitching", rec);
    assert.deepEqual(paths(verdict), ["expect.events[7]", "expect.events[7].user_id"]);
    const f = failureAt(verdict, "expect.events[7].user_id");
    assert.deepEqual([f.expected, f.actual], [{ $absent: true }, "u_123"]);
    assert.match(f.message, /user_id must be absent but is "u_123" at stream position 7/);
  });

  it("privacy passes on js", async () => {
    passes(await run("privacy", conforming.privacy("js")));
  });

  it("privacy fails when typed text leaks into a payload, and says where", async () => {
    const rec = conforming.privacy("js");
    rec.batches[0][3].properties = { password: "hunter2-secret" };
    const verdict = await run("privacy", rec);
    assert.deepEqual(paths(verdict), ["expect.payload_never_contains[0]"]);
    assert.equal(failureAt(verdict, "expect.payload_never_contains[0]").actual, "request 0 at /batch/3/properties/password");
  });

  it("property-limits passes on js and on php", async () => {
    passes(await run("property-limits", conforming["property-limits"]("js")));
    passes(await run("property-limits", conforming["property-limits"]("php")));
  });

  it("property-limits fails when a $ property key is not refused locally", async () => {
    const rec = conforming["property-limits"]("js");
    rec.warnings.pop();
    const verdict = await run("property-limits", rec);
    assert.deepEqual(paths(verdict), ["expect.local_rejections[2]"]);
    const f = failureAt(verdict, "expect.local_rejections[2]");
    assert.deepEqual(f.expected, { name: "upgrade", reason: "reserved_property_key" });
    assert.equal(f.actual, null);
  });
});

// ---- the rest of the rules ----------------------------------------------------------------

describe("POST /__verify, matcher and check rules", () => {
  it("$repeat: a stream that ends early names the matcher and the repeat item", async () => {
    const rec = conforming["offline-then-online"]("kotlin");
    rec.batches[0].pop();
    const verdict = await run("offline-then-online", rec);
    assert.deepEqual(paths(verdict), ["expect.events[2]"]);
    assert.match(failureAt(verdict, "expect.events[2]").message, /stream ended after 51 event\(s\); expected another track button_tap \(\$repeat item 50 of 50\)/);
  });

  it("$count: properties must have exactly the listed number of keys", async () => {
    const rec = conforming["property-limits"]("swift");
    delete rec.batches[0].at(-1)!.properties.k99;
    const verdict = await run("property-limits", rec);
    assert.deepEqual(paths(verdict), ["expect.events[2]", "expect.events[2].properties.$count"]);
    assert.deepEqual([failureAt(verdict, "expect.events[2].properties.$count").expected, failureAt(verdict, "expect.events[2].properties.$count").actual], [100, 99]);
  });

  it("$session: a new label must not reuse another label's session_id", async () => {
    const rec = conforming["session-timeout"]("js");
    const s1 = rec.batches[0][0].session_id;
    const resumed = rec.batches[2].at(-1)!;
    resumed.session_id = s1;
    resumed.seq = 6;
    const verdict = await run("session-timeout", rec);
    assert.deepEqual(paths(verdict), ["expect.events[6].$session"]);
    assert.match(failureAt(verdict, "expect.events[6].$session").message, /session "s2" starts at stream position 6 .* which session "s1" already uses/);
  });

  it("$platforms: matchers for other platforms are skipped", async () => {
    // The php recording has no session events; the client matchers are skipped and the php one applies.
    const verdict = await run("backoff-429", conforming["backoff-429"]("php"));
    passes(verdict);
    // The same php events checked as js fail, because the session matchers now apply.
    const asJs = await run("backoff-429", conforming["backoff-429"]("php"), { platform: "js" });
    assert.equal(asJs.pass, false);
    assert.ok(paths(asJs).includes("expect.events[0].type"));
  });

  it("seq_contiguous_per_session names the session and the expected seq", async () => {
    const rec = conforming["offline-then-online"]("js");
    rec.batches[0][10].seq = 11;
    const verdict = await run("offline-then-online", rec);
    const f = failureAt(verdict, "expect.checks.seq_contiguous_per_session");
    assert.deepEqual([f.expected, f.actual], [10, 11]);
    assert.match(f.message, /should continue with seq 10 at stream position 10/);
  });

  it("seq_contiguous_per_session on php requires seq 0 everywhere", async () => {
    const rec = conforming["backoff-429"]("php");
    for (const batch of rec.batches) batch[1].seq = 1;
    const verdict = await run("backoff-429", rec);
    assert.deepEqual(paths(verdict), ["expect.checks.seq_contiguous_per_session", "expect.events[3]", "expect.events[3].seq"]);
  });

  it("device_id_constant", async () => {
    const rec = conforming["offline-then-online"]("js");
    rec.batches[0].at(-1)!.device_id = uuid(999_999);
    const verdict = await run("offline-then-online", rec);
    assert.deepEqual(paths(verdict), ["expect.checks.device_id_constant"]);
  });

  it("session_end_consistent checks duration, events_count and screens_viewed", async () => {
    const rec = conforming["process-kill"]("swift");
    const end = rec.batches[0].find((e) => e.type === "session_end")!;
    end.duration_ms += 1;
    end.events_count = 10;
    end.screens_viewed = 1;
    let verdict = await run("process-kill", rec);
    assert.deepEqual(paths(verdict), ["expect.checks.session_end_consistent.duration_ms"]);

    const rec2 = conforming["identity-stitching"]("js");
    const end2 = rec2.batches[0].find((e) => e.type === "session_end")!;
    end2.screens_viewed = 0;
    end2.events_count = 7;
    verdict = await run("identity-stitching", rec2);
    assert.deepEqual(paths(verdict), ["expect.checks.session_end_consistent.events_count", "expect.events[5]", "expect.events[5].events_count"]);
  });

  it("requests bounds count every request whatever its status", async () => {
    const rec = conforming["offline-then-online"]("js");
    const [all] = rec.batches;
    rec.batches = [all.slice(0, 30), all.slice(30)];
    const verdict = await run("offline-then-online", rec);
    assert.deepEqual(paths(verdict), ["expect.requests.max"]);
    assert.match(failureAt(verdict, "expect.requests.max").message, /recorded 2 \(index:status 0:202, 1:202\)/);
  });

  it("fails when the fixture was not loaded with POST /__scenario first", async () => {
    const verdict = await run("privacy", conforming.privacy("js"), { loadAs: { id: "something-else", respond: [] } });
    assert.deepEqual(paths(verdict), ["scenario"]);
    assert.deepEqual([failureAt(verdict, "scenario").expected, failureAt(verdict, "scenario").actual], ["privacy", "something-else"]);
  });

  it("fails when the recording comes from a platform the fixture does not list", async () => {
    const verdict = await run("process-kill", conforming["process-kill"]("js"));
    assert.deepEqual(paths(verdict), ["platforms"]);
  });

  it("fails on an unexpected local warning", async () => {
    const rec = conforming.privacy("js");
    rec.warnings.push({ reason: "invalid_name", name: "" });
    const verdict = await run("privacy", rec);
    assert.deepEqual(paths(verdict), ["expect.local_rejections"]);
  });

  it("an empty recording fails on platform, bounds and events, not with an error", async () => {
    await postJson("/__scenario", fixture("privacy"));
    const verdict = (await postJson("/__verify", { fixture: "privacy" })).json;
    assert.equal(verdict.pass, false);
    assert.deepEqual(paths(verdict), ["expect.events[0]", "expect.requests.min", "platform"]);
  });
});

describe("POST /__verify, bad requests", () => {
  it("404 for a fixture that does not exist", async () => {
    const r = await postJson("/__verify", { fixture: "no-such-fixture" });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "unknown_fixture");
  });

  it("400 for a missing or malformed fixture id, bad warnings, or a body that is not JSON", async () => {
    for (const body of [{}, { fixture: "../schema/batch.schema" }, { fixture: "privacy", local: { warnings: [{ reason: 1 }] } }, { fixture: "privacy", local: { warnings: "none" } }]) {
      const r = await postJson("/__verify", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, "invalid_verify_request");
    }
    const notJson = await postJson("/__verify", "{nope");
    assert.equal(notJson.status, 400);
    assert.equal(notJson.json.error, "malformed_body");
  });
});
