/* A pinned release input for a test, from the pack build's download cache.
 *
 * Two tests read ICU's release archives through the pack build's own
 * functions (icu-data.mjs): they use the files in node_modules/.cache when
 * those match their pins, and download them through the retry helper
 * (download.mjs) when they do not. CI restores the cache the pack build
 * saved (.github/actions/icu-downloads), so no request leaves the runner
 * there. A download can take the helper's whole retry window, which is
 * longer than a test's timeout, so a test awaits its input in a `beforeAll`
 * with PINNED_INPUT_HOOK_TIMEOUT_MS and reads it in each test:
 *
 *   let data: () => string;
 *   beforeAll(async () => {
 *     data = await pinnedInput("ICU's full data file", () => ensureIcuData(dir));
 *   }, PINNED_INPUT_HOOK_TIMEOUT_MS);
 *
 * The hook never fails. A test that calls `data()` fails with "download
 * failed: ..." when the input was not cached and could not be fetched, which
 * says nothing about the data, and with the function's own error when the
 * bytes do not match their pin. */
import { RETRY_DELAYS_MS } from "../scripts/download.mjs";

/** The longest a download through the retry helper is given: the helper's
 * waits, and a minute for each of its requests. */
export const PINNED_INPUT_BUDGET_MS =
  RETRY_DELAYS_MS.reduce((sum, wait) => sum + wait, 0) + (RETRY_DELAYS_MS.length + 1) * 60_000;

/** The timeout of a hook that awaits `pinnedInput`. */
export const PINNED_INPUT_HOOK_TIMEOUT_MS = PINNED_INPUT_BUDGET_MS + 60_000;

/** Awaits `ensure()` for at most `budgetMs` and returns a function that gives
 * its result, or throws what went wrong. `what` names the input in the
 * "download failed" message. */
export async function pinnedInput<T>(
  what: string,
  ensure: () => Promise<T>,
  budgetMs: number = PINNED_INPUT_BUDGET_MS,
): Promise<() => T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `download failed: ${what} is not in the download cache and the release host ` +
              `did not finish answering within ${Math.round(budgetMs / 1000)} s`,
          ),
        ),
      budgetMs,
    );
  });
  try {
    const value = await Promise.race([ensure(), late]);
    return () => value;
  } catch (error) {
    // download.mjs starts every failure of a request with these words; a
    // mismatch with a pin is reported by the caller in its own words.
    const failure =
      error instanceof Error && error.message.startsWith("could not download ")
        ? new Error(
            `download failed: ${what} is not in the download cache and could not be ` +
              `fetched: ${error.message}`,
            { cause: error },
          )
        : error;
    return () => {
      throw failure;
    };
  } finally {
    clearTimeout(timer);
  }
}
