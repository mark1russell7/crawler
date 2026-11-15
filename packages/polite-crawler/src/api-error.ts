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
