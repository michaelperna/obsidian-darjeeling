/**
 * Record every `requestUrl` call src/ makes and answer it from the test.
 *
 *   const rec = recordRequestUrl((req) => jsonResponse({ agents: [] }));
 *   await sessions.listAgents();
 *   assert.equal(rec.calls[0].url, "http://10.0.0.1:8765/api/agents");
 *   rec.restore();
 *
 * Like Obsidian's requestUrl, a status >= 400 throws unless the request set
 * `throw: false`, so error handling is exercised the way the app does it.
 */
import {
  setRequestUrlHandler,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "./obsidian";

export type Responder = (
  request: RequestUrlParam
) => Partial<RequestUrlResponse> | Promise<Partial<RequestUrlResponse>>;

export interface RequestUrlRecorder {
  readonly calls: RequestUrlParam[];
  /** Parsed JSON body of call `i` (undefined when the body is not JSON). */
  body(i: number): any;
  restore(): void;
}

export function jsonResponse(json: unknown, status = 200): Partial<RequestUrlResponse> {
  return { status, json, text: JSON.stringify(json) };
}

export function textResponse(text: string, status = 200): Partial<RequestUrlResponse> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status, text, json };
}

export function recordRequestUrl(responder: Responder = () => jsonResponse({})): RequestUrlRecorder {
  const calls: RequestUrlParam[] = [];
  setRequestUrlHandler(async (request) => {
    calls.push(request);
    const partial = await responder(request);
    const response: RequestUrlResponse = {
      status: partial.status ?? 200,
      headers: partial.headers ?? {},
      text: partial.text ?? (partial.json !== undefined ? JSON.stringify(partial.json) : ""),
      json: partial.json,
      arrayBuffer: partial.arrayBuffer ?? new ArrayBuffer(0),
    };
    if (response.status >= 400 && request.throw !== false) {
      throw new Error(`Request failed, status ${response.status}`);
    }
    return response;
  });
  return {
    calls,
    body(i: number) {
      const raw = calls[i]?.body;
      if (typeof raw !== "string") return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    restore() {
      setRequestUrlHandler(null);
    },
  };
}
