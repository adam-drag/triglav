import { createHash, randomBytes } from 'node:crypto';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`, 404);
export const forbidden = (message: string) => new AppError('forbidden', message, 403);
export const conflict = (message: string) => new AppError('conflict', message, 409);
export const invalid = (message: string) => new AppError('invalid', message, 400);

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export const TOKEN_PREFIX = 'orch_tok_';
export const TICKET_PREFIX = 'orch_spawn_';

export function newSecret(prefix: string): string {
  return prefix + randomBytes(24).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

/** Strings that look like credentials must never be posted on the board. */
const SECRET_PATTERNS: RegExp[] = [
  /orch_(tok|spawn)_[A-Za-z0-9_-]{16,}/,
  /lin_(api|oauth)_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function assertNoSecrets(...texts: (string | null | undefined)[]): void {
  for (const text of texts) {
    if (!text) continue;
    if (SECRET_PATTERNS.some((p) => p.test(text))) {
      throw invalid('The text contains something that looks like a credential. Never post secrets on the board.');
    }
  }
}
