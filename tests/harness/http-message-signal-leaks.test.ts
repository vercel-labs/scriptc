/* A message's signal listeners under LeakSanitizer. An 'abort' listener
 * usually captures the IncomingMessage it belongs to, and the message owns
 * its signal: the listener→message edge closes a cycle the reference count
 * alone cannot break. A message settles at 'close' (no later abort can
 * fire), and the settle drops the signal's listeners, so the exchange's
 * state is freed. The sanitized lanes otherwise run with detect_leaks=0,
 * so this runs the two message programs with LeakSanitizer explicitly on.
 * Linux only (Apple's ASan has no LeakSanitizer); runs in the SCRIPTC_SAN=1
 * lane. */
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
  "tests/corpus/http-incoming-signal-listener-release.ts",
  "tests/corpus/http-client-response-signal-listener-release.ts",
];

describe.skipIf(!sanitize || process.platform !== "linux")(
  "http message signal listeners under LeakSanitizer",
  () => {
    test.each(programs)("%s reports no leaks", { timeout: 300_000 }, async (program) => {
      const file = join(repoRoot, program);
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("san")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `http-message-signal-leaks-${key}`);
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
      const expected = await execFileAsync(
        process.execPath,
        ["--no-warnings", "--experimental-strip-types", file],
        {
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      expect(run.stdout).toBe(expected.stdout);
    });
  },
);

/* The same ownership at steady state: LeakSanitizer and the exit audit see a
 * settled exchange only after the exit teardown has already dropped every
 * event target's listeners, so the retention has to be measured while the
 * program runs. Many keep-alive exchanges each capture a 1 MiB buffer in an
 * 'abort' listener; the resident size after the last exchange is bounded
 * when the settle frees them and grows by the captured total when it does
 * not. AddressSanitizer's quarantine keeps freed buffers mapped, so the
 * bound only applies outside the sanitized lane. Linux only (the resident
 * size of a process is a Linux measurement here). */
describe.skipIf(process.platform !== "linux")(
  "http message signal retention at steady state",
  () => {
    test("500 capture-and-settle exchanges stay bounded", { timeout: 600_000 }, async () => {
      const file = join(repoRoot, "tests/fixtures/http-signal-growth/main.ts");
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update(sanitize ? "san" : "plain")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `http-signal-growth-${key}`);
      mkdirSync(outDir, { recursive: true });
      const result = await compile(file, {
        outPath: join(outDir, "program"),
        outDir,
        sanitize,
        backend: "llvm",
      });
      if (!result.ok) {
        throw new Error(
          "program failed to compile:\n" +
            result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
        );
      }
      const run = await execFileAsync(result.binaryPath, [], { maxBuffer: 16 * 1024 * 1024 });
      expect(run.stderr).toBe("");
      // ASan's quarantine keeps the freed buffers mapped, so the resident
      // size says nothing in the sanitized lane.
      if (sanitize) expect(run.stdout.startsWith("exchanges 500 ")).toBe(true);
      else expect(run.stdout).toBe("exchanges 500 rss under 200 MiB\n");
    });
  },
);
