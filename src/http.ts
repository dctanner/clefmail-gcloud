import { HttpError, SafeError } from "./errors.js";

export type Fetch = typeof fetch;

export async function jsonRequest(
  service: string,
  url: string,
  init: RequestInit,
  options: { fetch?: Fetch; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<any> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(25_000)])
    : AbortSignal.timeout(25_000);
  try {
    const response = await (options.fetch || fetch)(url, { ...init, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(service, response.status);
    }
    const maxBytes = options.maxBytes ?? 1_500_000;
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new SafeError(`${service}_response_limit`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SafeError(`${service}_empty_response`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new SafeError(`${service}_response_limit`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError(`${service}_request_failed`);
  }
}
