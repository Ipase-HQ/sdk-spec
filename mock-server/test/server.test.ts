// Drives the mock server over HTTP: every real rejection, every scripted response,
// the recording endpoints, and every file in ../examples/valid accepted untouched.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createMockServer, MAX_BODY_BYTES, type MockServer } from "../src/server.js";

type Event = Record<string, unknown>;
type Batch = { sent_at: string; batch: Event[] };

const examplesDir = new URL("../../examples/valid/", import.meta.url);
const validExamples = readdirSync(examplesDir).filter((f) => f.endsWith(".json")).sort();
const example = (name: string): Batch => JSON.parse(readFileSync(new URL(name, examplesDir), "utf8"));
const specVersion = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();
const scenariosFile = JSON.parse(readFileSync(new URL("../../fixtures/scenarios.json", import.meta.url), "utf8"));

const minimal = (): Batch => structuredClone(example("minimal.json"));
const withProperties = (count: number, value: unknown = 1): Batch => {
  const b = minimal();
  b.batch[0].properties = Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value]));
  return b;
};

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

beforeEach(async () => {
  await setScenario([]);
});

interface Reply {
  status: number;
  headers: Headers;
  json: any;
}
interface PostOptions {
  gzip?: boolean;
  auth?: boolean;
  headers?: Record<string, string>;
}

async function post(path: string, body: unknown, opts: PostOptions = {}): Promise<Reply> {
  let payload: Buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { "content-type": "application/json", "x-sdk": "test/0.0.0" };
  if (opts.auth !== false) headers.authorization = "Bearer wk_test_0123456789abcdef";
  if (opts.gzip) {
    payload = gzipSync(payload);
    headers["content-encoding"] = "gzip";
  }
  Object.assign(headers, opts.headers);
  const res = await fetch(base + path, { method: "POST", headers, body: new Uint8Array(payload) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}
const postBatch = (body: unknown, opts?: PostOptions) => post("/v1/batch", body, opts);
const setScenario = (respond: unknown, id?: string) => post("/__scenario", { id, respond }, { auth: false });
async function recorded(): Promise<{ scenario: string | null; remaining_scripted: number; requests: any[] }> {
  const res = await fetch(`${base}/__recorded`);
  return (await res.json()) as any;
}

describe("health and routing", () => {
  it("GET /__health reports the spec version and the schema id", async () => {
    const res = await fetch(`${base}/__health`);
    const json: any = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.spec_version, specVersion);
    assert.match(json.schema, /batch\.schema\.json$/);
  });

  it("unknown routes answer 404", async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});

describe("POST /v1/batch accepts the spec examples", () => {
  for (const file of validExamples) {
    it(`${file} is accepted with nothing rejected`, async () => {
      const payload = example(file);
      const r = await postBatch(payload, { gzip: true });
      assert.equal(r.status, 202, JSON.stringify(r.json));
      assert.deepEqual(r.json, { accepted: payload.batch.length, rejected: [] });
    });
  }

  it("records the decoded events, headers and metadata of a gzip request", async () => {
    const payload = example("mobile-session.json");
    await postBatch(payload, { gzip: true });
    const { requests } = await recorded();
    assert.equal(requests.length, 1);
    const [req] = requests;
    assert.equal(req.index, 0);
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/batch");
    assert.equal(req.compressed, true);
    assert.ok(req.body_bytes > 0 && req.body_bytes < JSON.stringify(payload).length);
    assert.equal(req.headers.authorization, "Bearer wk_test_0123456789abcdef");
    assert.equal(req.headers["x-sdk"], "test/0.0.0");
    assert.equal(req.headers["content-encoding"], "gzip");
    assert.ok(!Number.isNaN(Date.parse(req.received_at)));
    assert.deepEqual(req.body, payload);
    assert.deepEqual(req.events, payload.batch);
    assert.deepEqual(req.errors, []);
    assert.equal(req.response.status, 202);
    assert.deepEqual(req.response.body, { accepted: payload.batch.length, rejected: [] });
  });

  it("accepts an uncompressed body and records it as such", async () => {
    const r = await postBatch(minimal());
    assert.equal(r.status, 202);
    const { requests } = await recorded();
    assert.equal(requests[0].compressed, false);
  });
});

describe("real rejections, which never consume the script", () => {
  it("413 when the body on the wire is over 1 MB", async () => {
    const r = await postBatch(randomBytes(MAX_BODY_BYTES + 1));
    assert.equal(r.status, 413);
    assert.equal(r.json.error, "batch_too_large");
  });

  it("413 when the batch has more than 500 events", async () => {
    const b = minimal();
    b.batch = Array.from({ length: 501 }, () => structuredClone(b.batch[0]));
    const r = await postBatch(b, { gzip: true });
    assert.equal(r.status, 413);
    assert.equal(r.json.error, "batch_too_large");
  });

  it("400 when Content-Encoding says gzip but the body is not", async () => {
    const r = await postBatch(Buffer.from("not gzip"), { headers: { "content-encoding": "gzip" } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "malformed_body");
  });

  it("400 when the body is not JSON", async () => {
    const r = await postBatch(Buffer.from("{not json"));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "malformed_body");
  });

  it("401 without a bearer token", async () => {
    const missing = await postBatch(minimal(), { auth: false });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error, "unauthorized");
    const wrongScheme = await postBatch(minimal(), { auth: false, headers: { authorization: "Basic abc" } });
    assert.equal(wrongScheme.status, 401);
  });

  it("400 with details when the envelope fails the schema", async () => {
    const b: Partial<Batch> = minimal();
    delete b.sent_at;
    const r = await postBatch(b);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "schema_invalid");
    assert.ok(r.json.details.some((d: string) => d.includes("sent_at")));
    const { requests } = await recorded();
    assert.equal(requests[0].errors.length, r.json.details.length);
  });

  it("leaves the script untouched", async () => {
    await setScenario([{ status: 429, retry_after: 30 }]);
    const bad: Partial<Batch> = minimal();
    delete bad.sent_at;
    assert.equal((await postBatch(bad)).status, 400);
    assert.equal((await postBatch(minimal(), { auth: false })).status, 401);
    assert.equal((await recorded()).remaining_scripted, 1);
    assert.equal((await postBatch(minimal())).status, 429);
    assert.equal((await postBatch(minimal())).status, 202);
  });
});

describe("per-event rejections inside a 202", () => {
  it("schema_invalid for one bad event, the rest accepted", async () => {
    const b = example("mobile-session.json");
    delete b.batch[2].screen; // a screen event without its screen object
    const r = await postBatch(b);
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { accepted: b.batch.length - 1, rejected: [{ index: 2, reason: "schema_invalid" }] });
    const { requests } = await recorded();
    assert.ok(requests[0].errors.some((e: string) => e.startsWith("/batch/2")));
  });

  it("properties_too_many for 101 property keys", async () => {
    const r = await postBatch(withProperties(101));
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { accepted: 0, rejected: [{ index: 0, reason: "properties_too_many" }] });
  });

  it("properties_too_many for 101 trait keys", async () => {
    const b = minimal();
    b.batch[0].type = "identify";
    b.batch[0].user_id = "u_1";
    delete b.batch[0].name;
    b.batch[0].traits = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`t${i}`, true]));
    const r = await postBatch(b);
    assert.deepEqual(r.json.rejected, [{ index: 0, reason: "properties_too_many" }]);
  });

  it("property_value_too_long for a 1025-character string", async () => {
    const r = await postBatch(withProperties(1, "x".repeat(1025)));
    assert.deepEqual(r.json, { accepted: 0, rejected: [{ index: 0, reason: "property_value_too_long" }] });
  });

  it("reserved_name for a host app name starting with $", async () => {
    const b = minimal();
    b.batch[0].name = "$checkout";
    const r = await postBatch(b);
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { accepted: 0, rejected: [{ index: 0, reason: "reserved_name" }] });
  });

  it("schema_invalid, not reserved_name, for a reserved name used wrongly", async () => {
    const b = minimal();
    b.batch[0].name = "$tap"; // reserved and allowed, but $tap requires element
    const r = await postBatch(b);
    assert.deepEqual(r.json.rejected, [{ index: 0, reason: "schema_invalid" }]);
  });

  it("event_too_large for an event over 32 KB that is otherwise valid", async () => {
    const r = await postBatch(withProperties(40, "x".repeat(1000)));
    assert.deepEqual(r.json, { accepted: 0, rejected: [{ index: 0, reason: "event_too_large" }] });
  });
});

describe("scripted responses", () => {
  it("202 with scripted rejections merged in; the script wins on the same index", async () => {
    await setScenario([
      { status: 202, rejected: [{ index: 1, reason: "reserved_name" }, { index: 0, reason: "timestamp_out_of_range" }] },
    ]);
    const b = example("mobile-session.json");
    delete b.batch[0].launch_type; // real schema_invalid at index 0, overridden by the script
    const r = await postBatch(b);
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, {
      accepted: b.batch.length - 2,
      rejected: [
        { index: 0, reason: "timestamp_out_of_range" },
        { index: 1, reason: "reserved_name" },
      ],
    });
  });

  for (const status of [400, 401, 413, 500]) {
    it(`${status} when scripted`, async () => {
      await setScenario([{ status }]);
      const r = await postBatch(minimal());
      assert.equal(r.status, status);
      assert.equal(typeof r.json.error, "string");
      assert.equal((await recorded()).requests[0].response.status, status);
    });
  }

  it("429 with Retry-After", async () => {
    await setScenario([{ status: 429, retry_after: 30 }]);
    const r = await postBatch(minimal());
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "30");
    assert.equal(r.json.error, "rate_limited");
    const { requests } = await recorded();
    assert.equal(requests[0].response.headers["retry-after"], "30");
  });

  it("503 with Retry-After", async () => {
    await setScenario([{ status: 503, retry_after: 5 }]);
    const r = await postBatch(minimal());
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.equal(r.json.error, "queue_unavailable");
  });

  it("drop closes the connection and records it", async () => {
    await setScenario([{ drop: true }]);
    await assert.rejects(postBatch(minimal()));
    const { requests } = await recorded();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].response, { status: 0, dropped: true });
    assert.equal(requests[0].events.length, 1);
    assert.equal((await postBatch(minimal())).status, 202);
  });

  it("repeat expands an entry", async () => {
    await setScenario([{ status: 500, repeat: 2 }, { status: 202 }]);
    assert.equal((await recorded()).remaining_scripted, 3);
    assert.equal((await postBatch(minimal())).status, 500);
    assert.equal((await postBatch(minimal())).status, 500);
    assert.equal((await postBatch(minimal())).status, 202);
    assert.equal((await recorded()).remaining_scripted, 0);
  });

  it("delay_ms holds the answer", async () => {
    await setScenario([{ status: 202, delay_ms: 200 }]);
    const started = performance.now();
    assert.equal((await postBatch(minimal())).status, 202);
    assert.ok(performance.now() - started >= 180);
  });

  it("falls back to 202 with real validation once the script is spent", async () => {
    await setScenario([{ status: 503 }]);
    assert.equal((await postBatch(minimal())).status, 503);
    const r = await postBatch(withProperties(101));
    assert.equal(r.status, 202);
    assert.deepEqual(r.json.rejected, [{ index: 0, reason: "properties_too_many" }]);
  });

  it("accepts a whole scenario object from fixtures/scenarios.json", async () => {
    const backoff = scenariosFile.scenarios.find((s: any) => s.id === "backoff-429");
    const loaded = await post("/__scenario", backoff, { auth: false });
    assert.deepEqual(loaded.json, { ok: true, id: "backoff-429", queued: 2 });
    const first = await postBatch(minimal());
    assert.equal(first.status, 429);
    assert.equal(first.headers.get("retry-after"), "30");
    assert.equal((await postBatch(minimal())).status, 202);
    assert.equal((await recorded()).scenario, "backoff-429");
  });

  it("rejects a bad script with 400 invalid_script", async () => {
    const badStatus = await setScenario([{ status: 418 }]);
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.json.error, "invalid_script");
    assert.match(badStatus.json.message, /respond\[0\]/);
    assert.equal((await setScenario({ not: "an array" })).status, 400);
    assert.equal((await setScenario([{ status: 202, rejected: [{ index: "0" }] }])).status, 400);
    assert.equal((await setScenario([{ status: 500, repeat: 0 }])).status, 400);
  });
});

describe("recording endpoints", () => {
  it("GET /__recorded lists requests in arrival order", async () => {
    await postBatch(minimal());
    await postBatch(minimal(), { auth: false });
    await postBatch(minimal());
    const { requests } = await recorded();
    assert.deepEqual(requests.map((r: any) => r.index), [0, 1, 2]);
    assert.deepEqual(requests.map((r: any) => r.response.status), [202, 401, 202]);
  });

  it("POST /__scenario clears the recording", async () => {
    await postBatch(minimal());
    await setScenario([], "fresh");
    const state = await recorded();
    assert.equal(state.scenario, "fresh");
    assert.deepEqual(state.requests, []);
  });

  it("DELETE /__recorded clears the recording and keeps the script", async () => {
    await setScenario([{ status: 500 }]);
    await postBatch(minimal(), { auth: false });
    const res = await fetch(`${base}/__recorded`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const state = await recorded();
    assert.deepEqual(state.requests, []);
    assert.equal(state.remaining_scripted, 1);
  });
});
