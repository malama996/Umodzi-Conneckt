/**
 * HTTP-aware error used across the auth layer (Task 23).
 * The server's central error handler honours `statusCode` (< 500 messages
 * are echoed, ≥ 500 are masked), so auth code throws HttpError instead of
 * sending replies directly. `details` is only ever attached to 400-level
 * validation errors and never contains secrets.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
