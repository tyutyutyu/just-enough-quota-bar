import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Reads a fixture of `test/unit/sources/fixtures`. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, "../fixtures", name), "utf8"));
}

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** Sent as is instead of `body`, e.g. text that is not JSON. */
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

export interface FakeFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: { readonly url: string; readonly init: RequestInit | undefined }[];
}

/** A `fetch` that answers each URL with its reply and records every request. */
export function fakeFetch(replies: Readonly<Record<string, Reply | Error>>): FakeFetch {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies[url];
    if (reply === undefined) {
      throw new Error(`unexpected request: ${url}`);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return new Response(reply.text ?? JSON.stringify(reply.body ?? null), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const signal = (): AbortSignal => new AbortController().signal;
