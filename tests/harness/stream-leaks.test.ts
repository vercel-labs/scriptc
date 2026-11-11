/* Wrapped streams and duplex pairs under LeakSanitizer. `readable.wrap`
 * registers a context on the source that the receiver's _read references
 * too, and a pair's two sides hold each other, so both build reference
 * cycles the collector must reclaim; every path that tears a stream down
 * must also release the streams it retained. The sanitized lanes otherwise
 * run with detect_leaks=0, so this runs the stream programs with
 * LeakSanitizer explicitly on. Linux only (Apple's ASan has no
 * LeakSanitizer); runs in the SCRIPTC_SAN=1 lane. */
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
  "tests/corpus/stream-readable-wrap.ts",
  "tests/corpus/stream-cycle-reclamation.ts",
  "tests/corpus/stream-duplex-pair.ts",
];

describe.skipIf(!sanitize || process.platform !== "linux")("streams under LeakSanitizer", () => {
  test.for(programs)("%s reports no leaks", { timeout: 300_000 }, async (program) => {
    const file = join(repoRoot, program);
    const key = createHash("sha256")
      .update(file)
      .update(readFileSync(file))
      .update("san")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `stream-leaks-${key}`);
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
});
