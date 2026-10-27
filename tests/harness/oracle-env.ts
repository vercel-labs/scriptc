/* The environment part of the differential oracle cache key. The Node
 * oracle runs with the harness's inherited environment, so a program whose
 * output reads a variable (NODE_ENV, SCRIPTC_TEST_ENV, ...) must not reuse a
 * verdict recorded under a different value. The variables that number the
 * test runner's own workers differ between workers of one run and are left
 * out, so every worker shares the cache. */
const WORKER_VARIABLES = new Set(["VITEST_POOL_ID", "VITEST_WORKER_ID", "TINYPOOL_WORKER_ID"]);

export function oracleEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env)
    .filter((name) => !WORKER_VARIABLES.has(name) && env[name] !== undefined)
    .sort()
    .map((name) => `${name}=${env[name]}\0`)
    .join("");
}
