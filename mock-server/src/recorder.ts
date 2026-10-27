// Everything the mock server saw, in arrival order, for GET /__recorded.

export interface RecordedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  dropped?: boolean;
}

export interface RecordedRequest {
  index: number;
  received_at: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  compressed: boolean;
  body_bytes: number;
  body: unknown;
  events: unknown[];
  errors: string[];
  response: RecordedResponse;
}

export class Recorder {
  private requests: RecordedRequest[] = [];

  add(entry: Omit<RecordedRequest, "index">): RecordedRequest {
    const recorded = { index: this.requests.length, ...entry };
    this.requests.push(recorded);
    return recorded;
  }

  all(): RecordedRequest[] {
    return this.requests.slice();
  }

  reset(): void {
    this.requests = [];
  }
}
