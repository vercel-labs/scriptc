/* Repeating the HTTP/1 upgrade -> http2.performServerHandshake handoff must
 * not accumulate memory: the socket's previous reader context (the HTTP
 * parser's connection and its receive buffer) is retired to the socket and
 * released with it, so a remote client that keeps upgrading cannot grow the
 * process. The sanitized lanes otherwise run with detect_leaks=0, so this
 * runs the program with LeakSanitizer explicitly on. Linux only (Apple's ASan
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

const program = "tests/corpus/http2-perform-handshake-upgrade-repeat.ts";

describe.skipIf(!sanitize || process.platform !== "linux")(
  "http2 performServerHandshake handoffs under LeakSanitizer",
  () => {
    test(`${program} reports no leaks`, { timeout: 300_000 }, async () => {
      const file = join(repoRoot, program);
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("san")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `http2-handshake-leaks-${key}`);
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
      const expected = await execFileAsync(process.execPath, ["--experimental-strip-types", file], {
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(run.stdout).toBe(expected.stdout);
    });
  },
);
