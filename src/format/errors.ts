/** A problem in a format string; the format is unusable while any exist. */
export interface FormatError {
  /** Zero-based offset in the format string the problem refers to. */
  readonly position: number;
  readonly message: string;
}

/** Outcome of parsing one spec; failures never throw. */
export type SpecResult<T> =
  | { readonly ok: true; readonly spec: T }
  | { readonly ok: false; readonly message: string };

export function specOk<T>(spec: T): SpecResult<T> {
  return { ok: true, spec };
}

export function specError<T>(message: string): SpecResult<T> {
  return { ok: false, message };
}
