/* The sanitized lane builds the runtime with UBSan's function-type check:
 * every listener the runtime stores in a closure's untyped `fn` must be
 * callable through the pointer type the invoker uses. The programs below
 * exercise the fixed-arity invokers the check caught: pipe()'s own
 * listeners on a native stream (the destination's 'unpipe' and 'error') and
 * the pipe/unpipe listeners of a stream made through a constructor the
 * program holds as a checked-dynamic value. They run with halt_on_error so a
 * mismatch stops the run, and the check asserts no function-type report
 * reaches stderr. Linux only (runs in the SCRIPTC_SAN=1 lane). */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const programs = [
  "tests/corpus/1692-stream-pipe.ts",
  "tests/corpus/8884-stream-pipe-error-unhandled.ts",
  "tests/corpus/stream-constructor-pipe-events.cjs",
];

describe.skipIf(!sanitize || process.platform !== "linux")(
  "runtime listeners are called through their own function type",
  () => {
    test.each(programs)(
      "%s reports no function-type mismatch",
      { timeout: 300_000 },
      async (program) => {
        const file = join(repoRoot, program);
        const key = createHash("sha256")
          .update(file)
          .update(readFileSync(file))
          .update("san")
          .digest("hex")
          .slice(0, 16);
        const outDir = join(cacheDir, `function-pointers-${key}`);
        mkdirSync(outDir, { recursive: true });
        const result = await compile(file, {
          outPath: join(outDir, "program"),
          outDir,
          sanitize: true,
          backend: "llvm",
        });
        if (!result.ok) {
          throw new Error(
            "program failed to compile:\n" +
              result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
          );
        }
        const run = await execFileAsync(result.binaryPath, [], {
          env: {
            ...process.env,
            ASAN_OPTIONS: "detect_leaks=0",
            UBSAN_OPTIONS: "print_stacktrace=1:halt_on_error=1",
          },
          maxBuffer: 16 * 1024 * 1024,
        }).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
        const stderr = "stderr" in run ? (run.stderr ?? "") : "";
        expect(stderr).not.toContain("runtime error: call to function");
        // Programs that end in an uncaught throw print it under Node too;
        // only the function-type report is the failure this test names.
        const nodeRun = await execFileAsync(process.execPath, ["--no-warnings", file], {
          maxBuffer: 16 * 1024 * 1024,
        }).catch((error: { code?: number; stdout?: string }) => error);
        const expectedOut = "stdout" in nodeRun ? nodeRun.stdout : "";
        expect(run.stdout).toBe(expectedOut);
      },
    );
  },
);
