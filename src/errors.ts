export class SafeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class HttpError extends SafeError {
  constructor(public readonly service: string, public readonly status: number) {
    super(`${service}_http_${status}`);
  }
}

export function errorCode(error: unknown): string {
  return error instanceof SafeError ? error.code : "internal_error";
}

// Only pass explicitly selected, content-free fields. Never log provider bodies.
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}
