/**
 * A failure the app can show to the person using it. `code` is what the app acts on
 * (`busy` is tried again by itself, `invalid_request` is put right by the person);
 * `message` is written for staff, in plain words.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type AppErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'conflict'
  | 'busy'
  | 'not_configured'
  | 'limit_reached'
  | 'claude_unavailable'
  | 'claude_declined'
  | 'internal';
