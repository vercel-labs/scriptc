import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

function runCoverage(input: string): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", tsxLoader, cliEntry, "coverage", join(repoRoot, input)],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout });
          return;
        }
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error.code, stdout });
      },
    );
  });
}

const cases = [
  {
    name: "fully static analysis",
    input: "tests/corpus/400-fib.ts",
    exitCode: 0,
    verdict: "fully static",
  },
  {
    name: "successful partial analysis",
    input: "tests/coverage-fixtures/mixed.ts",
    exitCode: 0,
    verdict: "blockers:",
  },
  {
    name: "failed TypeScript preflight",
    input: "tests/coverage-fixtures/type-errors.ts",
    exitCode: 1,
    verdict: "not analyzable:",
  },
] as const;

test.each(cases)("$name exits $exitCode", async ({ input, exitCode, verdict }) => {
  const result = await runCoverage(input);
  expect(result.stdout).toContain(verdict);
  expect(result.exitCode).toBe(exitCode);
});
