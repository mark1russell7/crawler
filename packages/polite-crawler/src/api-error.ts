/**
 * The error of `polite-crawler/api`. It is in a module of its own, so `api.ts` and `quota.ts` import
 * it and do not import each other.
 */

/**
 * An error of the send or of the token. The `redact` function of the send examined its message.
 *
 * @beta
 */
export class ApiError extends Error {
  override readonly name: string = "ApiError";
}

/**
 * The names of `ApiError` and of each class that extends it. A new class of error adds its name here,
 * and the test of the guards fails when it does not.
 */
const NAMES: ReadonlySet<string> = new Set(["ApiError", "QuotaError"]);

/**
 * This function tells if a value is an error of `polite-crawler/api`: an `ApiError`, or a
 * `QuotaError`, which extends it. The error can come from this copy of the package or from another
 * copy, of this version or of an earlier one. `instanceof` is false across two copies, so the
 * function also accepts an `Error` with one of their names. Thus it also accepts an error of a
 * different library with one of these names. Use it on the errors of a call through
 * `polite-crawler/api`.
 *
 * @beta
 */
export const isApiError = (value: unknown): value is ApiError =>
  value instanceof ApiError || (value instanceof Error && NAMES.has(value.name));
