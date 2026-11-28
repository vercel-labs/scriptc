/* A 'pipe' listener attached through an untyped value receives a capsule
 * over the source stream, and the capsule keeps the type key it was created
 * with. A listener that keeps the value compares that key again when the
 * same source is piped a second time, so the emission must hand the capsule
 * a key that outlives its frame. The sanitized run builds the program with
 * ASan and turns on stack-use-after-return detection, which the sanitized
 * lanes otherwise leave off: before the emission interned the key, the
 * second pipe read the first emission's dead stack buffer. Linux only (runs
 * in the SCRIPTC_SAN=1 lane). */
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
const program = "tests/corpus/4391-pipe-listener-kept-stream.mjs";

describe.skipIf(!sanitize || process.platform !== "linux")(
  "pipe event capsules keep their key",
  () => {
    test(
      "a kept stream value is compared without reading a dead frame",
      { timeout: 300_000 },
      async () => {
        const file = join(repoRoot, program);
        const key = createHash("sha256")
          .update(file)
          .update(readFileSync(file))
          .update("san")
          .digest("hex")
          .slice(0, 16);
        const outDir = join(cacheDir, `pipe-capsule-key-${key}`);
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
          env: { ...process.env, ASAN_OPTIONS: "detect_stack_use_after_return=1:detect_leaks=0" },
          maxBuffer: 16 * 1024 * 1024,
        }).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
        expect(run.stderr).toBe("");
        expect("code" in run ? run.code : 0).toBe(0);
        const expected = await execFileAsync(process.execPath, ["--no-warnings", file], {
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(run.stdout).toBe(expected.stdout);
      },
    );
  },
);
