/** Options of the compiler's own process that the frontend process (frontend-process.ts) must not
 * receive, with the options among them that take their value as the next argument: the code of
 * --eval and --print would run in place of the frontend process's entry, and the inspector, watch
 * and test runner options belong to the process that was started with them. */
const OPTIONS_WITH_VALUES = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "--input-type",
  "--inspect-port",
  "--debug-port",
  "--watch-path",
  "--test-concurrency",
  "--test-coverage-branches",
  "--test-coverage-exclude",
  "--test-coverage-functions",
  "--test-coverage-include",
  "--test-coverage-lines",
  "--test-global-setup",
  "--test-isolation",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
]);
const OPTIONS = new Set(["-i", "--interactive", "-c", "--check", "--test"]);
const OPTION_PREFIXES = ["--inspect", "--debug-port", "--watch", "--test-", "--input-type="];

/** The Node.js options of the frontend process: `execArgv` without the options that run code
 * (--eval, --print), open an inspector, or watch or test, so that its own entry runs with the
 * compiler process's remaining options, such as heap limits and loaders. */
export function frontendProcessExecArgv(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const option = execArgv[index]!;
    // A short option group such as -pe takes the code that follows it.
    if (OPTIONS_WITH_VALUES.has(option) || /^-[a-z]*[ep][a-z]*$/i.test(option)) {
      index++;
      continue;
    }
    if (
      OPTIONS.has(option) ||
      option.startsWith("--eval=") ||
      option.startsWith("--print=") ||
      OPTION_PREFIXES.some((prefix) => option.startsWith(prefix))
    )
      continue;
    kept.push(option);
  }
  return kept;
}
