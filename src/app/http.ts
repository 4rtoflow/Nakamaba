export interface AppRequest {
  method: string;
  path: string;
  /** ヘッダー名は小文字 */
  headers: Record<string, string | undefined>;
  body: string;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function respond(
  status: number,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): AppResponse {
  return { status, headers: { ...BASE_HEADERS, 'Content-Type': contentType, ...headers }, body };
}

export function json(status: number, value: unknown): AppResponse {
  return respond(status, JSON.stringify(value), 'application/json; charset=utf-8');
}

export function errorResponse(error: HttpError): AppResponse {
  return respond(
    error.status,
    JSON.stringify({ error: error.code, message: error.message }),
    'application/json; charset=utf-8',
    error.headers,
  );
}
