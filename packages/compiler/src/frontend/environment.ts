/** SCRIPTC_* variables that report on a build, place its cache or control
 * backend emission (its parallelism, a requested worker failure). The
 * frontend's output does not depend on them, so they are left out of its
 * cache key. */
const FRONTEND_INDEPENDENT_VARIABLES = new Set([
  "SCRIPTC_CACHE_DIR",
  "SCRIPTC_CACHE_MAX_MB",
  // The shared checker server answers as the build's own checker does.
  "SCRIPTC_CHECKER_SERVER",
  // Prints the stack of a compiler crash beside its diagnostic.
  "SCRIPTC_CRASH_STACK",
  "SCRIPTC_EMIT_WORKERS",
  "SCRIPTC_EMIT_WORKER_FAIL",
  "SCRIPTC_EMIT_WORKER_FUNCTIONS",
  // Checking reused units leaves the lowered module as it is. Reusing them
  // (SCRIPTC_INCR_LOWERING) does not in a build with `--define`, which then
  // leaves the conditions the define decides to the run
  // (constant-conditions.ts), so that variable is part of the key.
  "SCRIPTC_INCR_VERIFY",
  // The backend's report of which module initializers it defers.
  "SCRIPTC_INITIALIZERS_TRACE",
  "SCRIPTC_TIMING",
]);

/** The SCRIPTC_* variables the frontend's output can depend on, sorted by name. */
export function frontendEnvironment(): [string, string | undefined][] {
  return Object.entries(process.env)
    .filter(([name]) => name.startsWith("SCRIPTC_") && !FRONTEND_INDEPENDENT_VARIABLES.has(name))
    .sort(([a], [b]) => a.localeCompare(b));
}
