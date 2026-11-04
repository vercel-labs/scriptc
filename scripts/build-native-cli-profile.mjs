/* How well the profile a native compiler build uses still describes the
 * compiler (scripts/build-native-cli.mts). A function whose control flow
 * changed since the profile was collected is optimized as without one, so
 * the share of the profiled functions that still match falls as compiler
 * code changes, and with it the profile's gain. */

// A profile refreshed on the same commit, with the same layout, matches all
// of the native compiler's profiled functions. The one #2679 replaced was 1.7
// days and 625 commits old and matched 85.4%; it left the compiler with 11 MB
// more text and 13 MiB more peak RSS on a cold build than the fresh profile.
// The committed profile matched 91.0% on main, 90 commits after collection.
// Below WARN_BELOW a build warns; below FAIL_BELOW a build with
// SCRIPTC_NATIVE_PROFILE_CHECK=1 fails, and a build without it warns that CI
// fails.
export const WARN_BELOW = 0.95;
export const FAIL_BELOW = 0.9;

export const REFRESH_COMMAND = "node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout>";

/** The report on a build's profile match: the summary line, and a warning
 * below WARN_BELOW or an error below FAIL_BELOW when `check` is set. A build
 * laid out differently from the instrumented build, or one that reused
 * partitions from its cache without their counts, has no comparable match, so
 * it gets neither. */
export function judgeProfileMatch(match, { check = false, layoutMatchesProfile = true } = {}) {
  const profiled = match.annotated + match.mismatched;
  const share = profiled === 0 ? 0 : match.annotated / profiled;
  const percent = (Math.floor(share * 1000) / 10).toFixed(1);
  // The same by the profile's counters: a changed hot function loses more
  // of the profile's gain than a changed cold one.
  const counts =
    match.annotatedCounts === undefined || match.mismatchedCounts === undefined
      ? 0
      : match.annotatedCounts + match.mismatchedCounts;
  const summary =
    `native compiler profile: ${match.annotated} of ${profiled} profiled functions match (${percent}%); ${match.missing} functions have no profile` +
    (counts > 0
      ? `; changed functions hold ${((100 * match.mismatchedCounts) / counts).toFixed(1)}% of its counts`
      : "") +
    (match.recovered > 0
      ? `; ${match.recovered} functions annotated from the profile's block counts`
      : "") +
    (match.unknownPartitions > 0
      ? `; ${match.unknownPartitions} partitions reused without counts`
      : "");
  if (match.unknownPartitions > 0 || !layoutMatchesProfile) return { summary };
  const advice = `refresh packages/compiler/native/cli.profdata.gz with \`${REFRESH_COMMAND}\` on a Linux x64 host and commit it`;
  const below = `the native compiler profile matches ${percent}% of the functions it describes, below`;
  if (share < FAIL_BELOW)
    return check
      ? { summary, error: `${below} ${FAIL_BELOW * 100}%; ${advice}` }
      : { summary, warning: `${below} ${FAIL_BELOW * 100}%, which fails in CI; ${advice}` };
  if (share < WARN_BELOW) return { summary, warning: `${below} ${WARN_BELOW * 100}%; ${advice}` };
  return { summary };
}
