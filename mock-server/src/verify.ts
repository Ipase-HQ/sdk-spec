// Evaluates a fixture's expect block against what the server recorded and the local warnings the
// harness reported. This is the only implementation of the matching rules in fixtures/README.md, so
// no SDK harness has to reimplement them: a harness drives the steps and then asks POST /__verify.
import { isDeepStrictEqual } from "node:util";
import type { RecordedRequest } from "./recorder.js";

export interface Failure {
  /** Where in the fixture the expectation lives, for example expect.events[3].screen.name. */
  path: string;
  expected: unknown;
  actual: unknown;
  /** One sentence that says what went wrong and where in the recording, enough to debug from. */
  message: string;
}

export interface VerifyResult {
  pass: boolean;
  fixture: string;
  platform: string | null;
  failures: Failure[];
}

export interface Warning {
  reason: string;
  name: string;
}

export interface VerifyInput {
  fixture: Fixture;
  /** The scenario id the server currently has loaded (POST /__scenario), or null. */
  loadedScenario: string | null;
  requests: RecordedRequest[];
  warnings: Warning[];
  /** Overrides the platform read from context.sdk.name of the recorded events. */
  platform?: string;
}

type Json = Record<string, unknown>;

export interface Fixture {
  id: string;
  platforms: string[];
  expect: {
    requests?: { min?: number; max?: number };
    events: Json[];
    checks?: string[];
    payload_never_contains?: string[];
    local_rejections?: Warning[];
  };
}

/** One event of the 202 stream with where it came from, so failures can point at it. */
interface Located {
  event: Json;
  position: number;
  request: number;
  index: number;
}

const ABSENT = { $absent: true };
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isAbsentMarker = (v: unknown): boolean => isDeepStrictEqual(v, ABSENT);
const where = (e: Located) => `stream position ${e.position} (request ${e.request}, batch index ${e.index})`;
const describe = (e: Json) => {
  const name = typeof e.name === "string" ? ` ${e.name}` : "";
  const screen = isObject(e.screen) && typeof e.screen.name === "string" ? ` ${e.screen.name}` : "";
  return `${String(e.type)}${name}${screen}`;
};
const timeOf = (v: unknown): number | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);

export function verify(input: VerifyInput): VerifyResult {
  const { fixture, requests, warnings } = input;
  const failures: Failure[] = [];
  const fail = (path: string, expected: unknown, actual: unknown, message: string) => failures.push({ path, expected, actual, message });

  if (input.loadedScenario !== fixture.id) {
    fail(
      "scenario",
      fixture.id,
      input.loadedScenario,
      `the server has scenario ${JSON.stringify(input.loadedScenario)} loaded; post fixtures/${fixture.id}.json to POST /__scenario before the first step`,
    );
  }

  const platform = resolvePlatform(input, fail);
  if (platform !== null && !fixture.platforms.includes(platform)) {
    fail("platforms", fixture.platforms, platform, `the recording comes from ${platform}, which this fixture does not list`);
  }

  const { expect } = fixture;
  checkRequestBounds(expect.requests, requests, fail);

  const stream = acceptedStream(requests);
  matchEvents(expect.events, stream, platform, fail);

  for (const check of expect.checks ?? []) runCheck(check, stream, requests, platform, fail);
  for (const [i, needle] of (expect.payload_never_contains ?? []).entries()) checkNeverContains(i, needle, requests, fail);
  checkLocalRejections(expect.local_rejections ?? [], warnings, fail);

  return { pass: failures.length === 0, fixture: fixture.id, platform, failures };
}

type Fail = (path: string, expected: unknown, actual: unknown, message: string) => void;

function resolvePlatform(input: VerifyInput, fail: Fail): string | null {
  if (input.platform !== undefined) return input.platform;
  const seen = new Set<string>();
  for (const req of input.requests) {
    for (const event of req.events) {
      const name = isObject(event) && isObject(event.context) && isObject(event.context.sdk) ? event.context.sdk.name : undefined;
      if (typeof name === "string") seen.add(name);
    }
  }
  if (seen.size === 1) return [...seen][0];
  if (seen.size === 0) {
    fail("platform", "one SDK name", null, "no recorded event carries context.sdk.name, so the platform is unknown; pass platform in the /__verify body");
  } else {
    fail("platform", "one SDK name", [...seen].sort(), `recorded events come from several SDKs: ${[...seen].sort().join(", ")}`);
  }
  return null;
}

function checkRequestBounds(bounds: { min?: number; max?: number } | undefined, requests: RecordedRequest[], fail: Fail): void {
  if (!bounds) return;
  const summary = requests.map((r) => `${r.index}:${r.response.dropped ? "dropped" : r.response.status}`).join(", ") || "none";
  if (bounds.min !== undefined && requests.length < bounds.min) {
    fail("expect.requests.min", bounds.min, requests.length, `expected at least ${bounds.min} request(s), recorded ${requests.length} (index:status ${summary})`);
  }
  if (bounds.max !== undefined && requests.length > bounds.max) {
    fail("expect.requests.max", bounds.max, requests.length, `expected at most ${bounds.max} request(s), recorded ${requests.length} (index:status ${summary})`);
  }
}

function acceptedStream(requests: RecordedRequest[]): Located[] {
  const out: Located[] = [];
  for (const req of requests) {
    if (req.response.status !== 202) continue;
    req.events.forEach((event, index) => {
      out.push({ event: isObject(event) ? event : {}, position: out.length, request: req.index, index });
    });
  }
  return out;
}

function matchEvents(matchers: Json[], stream: Located[], platform: string | null, fail: Fail): void {
  const sessions = new Map<string, string>(); // label -> session_id
  const labels = new Map<string, Located>();
  let cursor = 0;

  for (const [m, matcher] of matchers.entries()) {
    const only = matcher.$platforms as string[] | undefined;
    if (only && platform !== null && !only.includes(platform)) continue;
    const repeat = (matcher.$repeat as number | undefined) ?? 1;

    for (let k = 0; k < repeat; k++) {
      const base = `expect.events[${m}]`;
      const item = repeat > 1 ? ` ($repeat item ${k + 1} of ${repeat})` : "";
      const located = stream[cursor];
      if (!located) {
        fail(base, summarizeMatcher(matcher), null, `the 202 stream ended after ${stream.length} event(s); expected another ${describe(matcher)}${item}`);
        return;
      }
      const mismatches: Failure[] = [];
      matchFields(matcher, located.event, base, mismatches);
      if (mismatches.length) {
        for (const f of mismatches) fail(f.path, f.expected, f.actual, `${f.message} at ${where(located)}${item}, a ${describe(located.event)}`);
        fail(
          base,
          summarizeMatcher(matcher),
          located.event,
          `matching stopped at ${where(located)}${item}; the following events are ${preview(stream, cursor + 1)}`,
        );
        return;
      }
      cursor += 1;

      const label = matcher.$session as string | undefined;
      if (label !== undefined) checkSession(label, located, `${base}.$session`, sessions, fail);
      if (k === repeat - 1 && typeof matcher.$label === "string") labels.set(matcher.$label, located);
      if (typeof matcher.$same_timestamp_as === "string") {
        const ref = labels.get(matcher.$same_timestamp_as);
        if (ref && timeOf(ref.event.timestamp) !== timeOf(located.event.timestamp)) {
          fail(
            `${base}.$same_timestamp_as`,
            ref.event.timestamp,
            located.event.timestamp,
            `the timestamp at ${where(located)} must equal that of "${matcher.$same_timestamp_as}" at ${where(ref)}`,
          );
        }
      }
    }
  }

  if (cursor < stream.length) {
    fail(
      "expect.events",
      `${cursor} event(s)`,
      `${stream.length} event(s)`,
      `the 202 stream has ${stream.length - cursor} event(s) no matcher accounts for, starting at ${where(stream[cursor])}: ${preview(stream, cursor)}`,
    );
  }
}

function checkSession(label: string, located: Located, path: string, sessions: Map<string, string>, fail: Fail): void {
  const id = located.event.session_id;
  if (typeof id !== "string") return;
  const known = sessions.get(label);
  if (known !== undefined) {
    if (known !== id) fail(path, known, id, `session "${label}" has session_id ${known}, but the event at ${where(located)} carries ${id}`);
    return;
  }
  for (const [other, otherId] of sessions) {
    if (otherId === id) fail(path, `a session_id other than ${id}`, id, `session "${label}" starts at ${where(located)} with session_id ${id}, which session "${other}" already uses`);
  }
  sessions.set(label, id);
}

// Compares every non-$ key of the matcher with the event. Objects are compared key by key, so keys the
// matcher does not list are free; $absent forbids a key; $count inside properties or traits fixes the key count.
function matchFields(expected: Json, actual: Json, path: string, out: Failure[]): void {
  for (const [key, want] of Object.entries(expected)) {
    if (key.startsWith("$")) {
      if (key === "$count") {
        const count = Object.keys(actual).length;
        if (count !== want) out.push({ path: `${path}.$count`, expected: want, actual: count, message: `${path.split(".").pop()} has ${count} key(s), expected ${String(want)}` });
      }
      continue;
    }
    const got = actual[key];
    const here = `${path}.${key}`;
    if (isAbsentMarker(want)) {
      if (got !== undefined) out.push({ path: here, expected: ABSENT, actual: got, message: `${key} must be absent but is ${JSON.stringify(got)}` });
    } else if (isObject(want)) {
      if (!isObject(got)) out.push({ path: here, expected: want, actual: got ?? null, message: `${key} must be an object but is ${got === undefined ? "missing" : JSON.stringify(got)}` });
      else matchFields(want, got, here, out);
    } else if (!isDeepStrictEqual(want, got)) {
      out.push({ path: here, expected: want, actual: got ?? null, message: `${key} is ${got === undefined ? "missing" : JSON.stringify(got)}, expected ${JSON.stringify(want)}` });
    }
  }
}

function summarizeMatcher(matcher: Json): Json {
  return Object.fromEntries(Object.entries(matcher).filter(([k]) => !["$platforms"].includes(k)));
}

function preview(stream: Located[], from: number): string {
  const rest = stream.slice(from, from + 5).map((e) => describe(e.event));
  if (rest.length === 0) return "none";
  const more = stream.length - from - rest.length;
  return rest.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

function runCheck(check: string, stream: Located[], requests: RecordedRequest[], platform: string | null, fail: Fail): void {
  const path = `expect.checks.${check}`;
  switch (check) {
    case "event_ids_unique": {
      const first = new Map<unknown, Located>();
      for (const e of stream) {
        const seen = first.get(e.event.event_id);
        if (seen) fail(path, "unique event_id", e.event.event_id, `event_id ${String(e.event.event_id)} at ${where(e)} was already accepted at ${where(seen)}`);
        else first.set(e.event.event_id, e);
      }
      return;
    }
    case "seq_contiguous_per_session": {
      if (platform === "php") {
        for (const e of stream) {
          if (e.event.seq !== 0) fail(path, 0, e.event.seq, `server-side events always carry seq 0; ${where(e)} carries ${String(e.event.seq)}`);
        }
        return;
      }
      const next = new Map<unknown, number>();
      for (const e of stream) {
        const want = next.get(e.event.session_id) ?? 0;
        if (e.event.seq !== want) {
          fail(path, want, e.event.seq, `session ${String(e.event.session_id)} should continue with seq ${want} at ${where(e)}, a ${describe(e.event)}, but it carries ${String(e.event.seq)}`);
        }
        next.set(e.event.session_id, (typeof e.event.seq === "number" ? e.event.seq : want) + 1);
      }
      return;
    }
    case "device_id_constant": {
      const first = stream[0];
      for (const e of stream) {
        if (e.event.device_id !== first.event.device_id) {
          fail(path, first.event.device_id, e.event.device_id, `device_id changed at ${where(e)}; the first event carries ${String(first.event.device_id)}`);
        }
      }
      return;
    }
    case "session_end_consistent": {
      for (const end of stream.filter((e) => e.event.type === "session_end")) {
        const sid = end.event.session_id;
        const same = stream.filter((e) => e.event.session_id === sid);
        const start = same.find((e) => e.event.type === "session_start");
        if (!start) {
          fail(path, "a session_start", null, `the session_end at ${where(end)} has no session_start with session_id ${String(sid)} in the 202 stream`);
          continue;
        }
        const startTs = timeOf(start.event.timestamp);
        const endTs = timeOf(end.event.timestamp);
        const duration = startTs !== null && endTs !== null ? endTs - startTs : null;
        if (end.event.duration_ms !== duration) {
          fail(`${path}.duration_ms`, duration, end.event.duration_ms, `the session_end at ${where(end)} must have duration_ms = its timestamp minus the session_start at ${where(start)}`);
        }
        const seq = end.event.seq;
        const count = typeof seq === "number" ? seq + 1 : null;
        if (end.event.events_count !== count) {
          fail(`${path}.events_count`, count, end.event.events_count, `the session_end at ${where(end)} must have events_count = its seq plus one`);
        }
        const screens = same.filter((e) => e.event.type === "screen").length;
        if (end.event.screens_viewed !== screens) {
          fail(`${path}.screens_viewed`, screens, end.event.screens_viewed, `the session_end at ${where(end)} must count the ${screens} screen event(s) of its session`);
        }
      }
      return;
    }
    case "rejected_requests_resent": {
      for (const req of requests) {
        if (req.response.status === 202) continue;
        const later = new Set(requests.filter((r) => r.index > req.index).flatMap((r) => r.events.map((e) => (isObject(e) ? e.event_id : undefined))));
        const missing = req.events.map((e) => (isObject(e) ? e.event_id : undefined)).filter((id) => !later.has(id));
        if (missing.length) {
          const status = req.response.dropped ? "dropped" : String(req.response.status);
          fail(path, "every event_id resent", missing, `request ${req.index} got ${status}, but ${missing.length} of its event_ids never appear in a later request`);
        }
      }
      return;
    }
    default:
      fail(path, "a known check", check, `unknown check ${check}`);
  }
}

function checkNeverContains(i: number, needle: string, requests: RecordedRequest[], fail: Fail): void {
  for (const req of requests) {
    const at = findString(req.body, needle, "");
    if (at !== null) {
      fail(`expect.payload_never_contains[${i}]`, `no "${needle}"`, `request ${req.index} at ${at || "/"}`, `"${needle}" occurs in request ${req.index} at ${at || "/"}`);
    }
  }
}

// JSON pointer of the first key or string value containing needle, or null.
function findString(value: unknown, needle: string, pointer: string): string | null {
  if (typeof value === "string") return value.includes(needle) ? pointer : null;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = findString(v, needle, `${pointer}/${i}`);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const here = `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (k.includes(needle)) return here;
      const hit = findString(v, needle, here);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function checkLocalRejections(expected: Warning[], reported: Warning[], fail: Fail): void {
  const n = Math.max(expected.length, reported.length);
  for (let i = 0; i < n; i++) {
    const want = expected[i];
    const got = reported[i];
    const path = `expect.local_rejections[${i}]`;
    if (want && !got) {
      fail(path, want, null, `the SDK reported ${reported.length} local warning(s); expected one for "${want.name}" with reason ${want.reason}`);
    } else if (!want && got) {
      fail("expect.local_rejections", `${expected.length} warning(s)`, got, `unexpected local warning ${i}: "${got.name}" refused with ${got.reason}`);
    } else if (want && got && (want.name !== got.name || want.reason !== got.reason)) {
      fail(path, want, got, `local warning ${i} is "${got.name}" with ${got.reason}, expected "${want.name}" with ${want.reason}`);
    }
  }
}
