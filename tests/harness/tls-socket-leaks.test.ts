/* new tls.TLSSocket under LeakSanitizer. A TLS socket's transport holds
 * its 'secure' and 'session' listeners, which often capture the socket;
 * every socket that closes, including one whose handshake fails, must drop
 * them. The sanitized lanes otherwise run with detect_leaks=0, so this runs
 * the TLSSocket programs with LeakSanitizer explicitly on. 7094's
 * handshakes all fail; 7095's detailed certificates link roots to
 * themselves; 7097 and 7098 hold client certificates and the chains a ca
 * completes. Linux only (Apple's ASan has no LeakSanitizer);
 * runs in the SCRIPTC_SAN=1 lane. */
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
  "tests/corpus/7087-tls-socket-wrap.ts",
  "tests/corpus/7088-tls-socket-connect-tunnel.ts",
  "tests/corpus/7094-tls-socket-failed-handshakes.ts",
  "tests/corpus/7095-tls-peer-certificates.ts",
  "tests/corpus/7097-tls-client-certificates.ts",
  "tests/corpus/7098-tls-client-certificates-paths.ts",
  "tests/corpus/7440-tls-server-add-context.ts",
  "tests/corpus/7441-tls-client-error.ts",
  "tests/corpus/7443-tls-final-flight.ts",
];

describe.skipIf(!sanitize || process.platform !== "linux")(
  "tls.TLSSocket under LeakSanitizer",
  () => {
    test.each(programs)("%s reports no leaks", { timeout: 300_000 }, async (program) => {
      const file = join(repoRoot, program);
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("san")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `tls-socket-leaks-${key}`);
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
