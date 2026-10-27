// The scripted side of the mock server. A scenario is a queue of responses for
// POST /v1/batch; each request that passes the real checks consumes one entry.
// When the queue is empty the server answers 202 with real per-event validation.

export interface Rejection {
  index: number;
  reason: string;
}

export interface ScriptedResponse {
  /** 202, 400, 401, 413, 429, 500 or 503. */
  status?: number;
  /** Seconds, sent as the Retry-After header on 429 and 503. */
  retry_after?: number;
  /** Extra per-event rejections merged into a 202 body. Wins over real validation on the same index. */
  rejected?: Rejection[];
  /** Close the connection without answering. */
  drop?: boolean;
  /** Milliseconds to wait before answering. */
  delay_ms?: number;
  /** Use this entry that many times. Default 1. */
  repeat?: number;
}

export const SCRIPTABLE_STATUSES = [202, 400, 401, 413, 429, 500, 503] as const;

const isNonNegativeInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/** Validates a script coming over HTTP. Throws an Error whose message names the bad entry. */
export function parseScript(input: unknown): ScriptedResponse[] {
  if (!Array.isArray(input)) throw new Error("respond must be an array");
  return input.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`respond[${i}] must be an object`);
    }
    const r = entry as ScriptedResponse;
    if (r.drop !== true && !(SCRIPTABLE_STATUSES as readonly number[]).includes(r.status as number)) {
      throw new Error(`respond[${i}] needs drop: true or a status in ${SCRIPTABLE_STATUSES.join(", ")}`);
    }
    if (r.repeat !== undefined && (!Number.isInteger(r.repeat) || r.repeat < 1)) {
      throw new Error(`respond[${i}].repeat must be a positive integer`);
    }
    if (r.delay_ms !== undefined && !isNonNegativeInt(r.delay_ms)) {
      throw new Error(`respond[${i}].delay_ms must be a non-negative integer`);
    }
    if (r.retry_after !== undefined && !isNonNegativeInt(r.retry_after)) {
      throw new Error(`respond[${i}].retry_after must be a non-negative integer`);
    }
    if (r.rejected !== undefined) {
      const ok =
        Array.isArray(r.rejected) &&
        r.rejected.every((x) => typeof x === "object" && x !== null && isNonNegativeInt(x.index) && typeof x.reason === "string");
      if (!ok) throw new Error(`respond[${i}].rejected must be an array of { index, reason }`);
    }
    return r;
  });
}

export class Scenario {
  id: string | null = null;
  private queue: ScriptedResponse[] = [];

  load(id: string | null, script: ScriptedResponse[]): void {
    this.id = id;
    this.queue = script.flatMap(({ repeat, ...rest }) => Array.from({ length: repeat ?? 1 }, () => ({ ...rest })));
  }

  next(): ScriptedResponse | undefined {
    return this.queue.shift();
  }

  get remaining(): number {
    return this.queue.length;
  }
}
