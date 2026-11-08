/* Downloads of the pack build's pinned inputs, repeated when a repeat can help.
 *
 * A from-scratch pack build fetches ICU's release archives (icu-data.mjs).
 * One request that the release host answers with a gateway error used to fail
 * the whole build, and with it every CI job whose pack cache had missed. A
 * request is repeated here when the failure describes the host or the path to
 * it at that moment, not the request: a network error, or one of the statuses
 * in TRANSIENT_STATUSES. Any other status (a 404 for a wrong pin, a 403) fails
 * at once, as before. The caller still verifies the bytes against its pin.
 */

/** Statuses a later request can cure. */
export const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** The waits before attempts two to seven: 470 seconds in all. On 2026-11-08
 * the release host answered 504 on and off for about forty minutes, and three
 * of six from-scratch builds failed inside a window of two minutes. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 240_000];

/** The longest wait a `Retry-After` header can ask for. */
export const RETRY_AFTER_LIMIT_MS = 120_000;

/** The wait a `Retry-After` header asks for, in milliseconds: its value is a
 * number of seconds or an HTTP date. Zero when the header is absent or
 * unreadable; never more than RETRY_AFTER_LIMIT_MS.
 * @param {string | null | undefined} value
 * @param {number} [now] */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined) return 0;
  const text = value.trim();
  if (text === "") return 0;
  const wait = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (!Number.isFinite(wait) || wait <= 0) return 0;
  return Math.min(wait, RETRY_AFTER_LIMIT_MS);
}

/** @param {unknown} error */
function describeNetworkError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = /** @type {{ code?: unknown, message?: unknown } | undefined} */ (error.cause);
  const detail = cause?.code ?? cause?.message;
  return detail === undefined ? error.message : `${error.message} (${String(detail)})`;
}

/** The bytes at `url`. `what` names the input in messages ("ICU's sources").
 * Transient failures are repeated after `delays[i]` milliseconds, or after the
 * response's `Retry-After` when that is longer; when the last attempt fails
 * too, the error says "transient download failure after N attempts" with the
 * last status or network error, then `hint`.
 * @param {string} url
 * @param {string} what
 * @param {{
 *   fetch?: (url: string) => Promise<Response>,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   delays?: readonly number[],
 *   log?: (message: string) => void,
 *   hint?: string,
 * }} [options]
 * @returns {Promise<Buffer>} */
export async function download(url, what, options = {}) {
  const {
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    delays = RETRY_DELAYS_MS,
    log = (message) => console.error(message),
    hint = "",
  } = options;
  const attempts = delays.length + 1;
  for (let attempt = 1; ; attempt++) {
    /** What went wrong, when it is worth another attempt. */
    let last;
    let cause;
    let retryAfter = 0;
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      last = describeNetworkError(error);
      cause = error;
    }
    if (response !== undefined) {
      const status = `${response.status} ${response.statusText}`.trim();
      if (response.ok) {
        try {
          return Buffer.from(await response.arrayBuffer());
        } catch (error) {
          // The connection ended inside the body.
          last = `${status}, then ${describeNetworkError(error)}`;
          cause = error;
        }
      } else {
        if (!TRANSIENT_STATUSES.has(response.status))
          throw new Error(`could not download ${what} (${url}): ${status}`);
        last = status;
        retryAfter = retryAfterMs(response.headers.get("retry-after"));
        // Release the connection; the error page is not read.
        await response.body?.cancel().catch(() => {});
      }
    }
    if (attempt === attempts)
      throw new Error(
        `could not download ${what} (${url}): transient download failure after ` +
          `${attempts} attempts, last: ${last}${hint === "" ? "" : `; ${hint}`}`,
        cause === undefined ? undefined : { cause },
      );
    const wait = Math.max(delays[attempt - 1], retryAfter);
    log(
      `download of ${what} failed (${last}); attempt ${attempt + 1} of ${attempts} ` +
        `in ${Math.round(wait / 1000)} s`,
    );
    await sleep(wait);
  }
}
