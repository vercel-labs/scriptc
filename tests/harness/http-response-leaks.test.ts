/* Cancelled HTTP/2 HEAD responses under LeakSanitizer. A response keeps the
 * 'finish' and 'close' listeners registered before its stream closed, and a
 * listener that captures its response, directly or through a record that
 * holds it, closes a cycle with it; the response and its listeners must be
 * reclaimed without a later end(). The sanitized lanes otherwise run with
 * detect_leaks=0, so this runs the program with
 * LeakSanitizer explicitly on; the sanitized build's RC audit is the second
 * check (it names every object still live at exit). Linux only (Apple's ASan
 * has no LeakSanitizer); runs in the SCRIPTC_SAN=1 lane. */
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
  "tests/corpus/http2-head-cancel-response-listeners.cjs",
  "tests/corpus/http-head-cancel-response-listeners.cjs",
  "tests/corpus/http2-head-cancel-response-record.ts",
];

describe.skipIf(!sanitize || process.platform !== "linux")(
  "HTTP responses under LeakSanitizer",
  () => {
    test.each(programs)("%s reports no leaks", { timeout: 300_000 }, async (program) => {
      const file = join(repoRoot, program);
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("san")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `http-response-leaks-${key}`);
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
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1" },
        maxBuffer: 16 * 1024 * 1024,
      }).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
      expect(run.stderr).toBe("");
      expect("code" in run ? run.code : 0).toBe(0);
      const expected = await execFileAsync(process.execPath, ["--no-warnings", file], {
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(run.stdout).toBe(expected.stdout);
    });
  },
);
