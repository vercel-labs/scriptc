/* Request-triggered temporary servers whose persistent 'close' listeners
 * capture their server and the request's payload. A settled server keeps its
 * 'close' listeners only for the sweep that emits its 'close', and the sweep
 * then releases them, so a listener that captured the server cannot keep it
 * (or its payload) alive past that sweep. Without that release every request
 * left its server and payload allocated until exit.
 *
 * LeakSanitizer and the exit audit cannot see it (the exit teardown drops the
 * listener lists first), so the retention is measured while the program runs:
 * 400 requests each carrying their own 8 KiB payload stay under 40 MiB when
 * the listeners go with the sweep and grow past it when they do not. Linux
 * only (the resident size of a process is a Linux measurement here), and
 * skipped in the sanitized lane, whose quarantine keeps freed blocks mapped. */
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

describe.skipIf(sanitize || process.platform !== "linux")(
  "request-triggered servers with self-capturing close listeners",
  () => {
    test("400 temporary servers stay bounded", { timeout: 600_000 }, async () => {
      const file = join(repoRoot, "tests/fixtures/net-close-listener-request-cycles/main.ts");
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("plain")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `net-close-listener-request-cycles-${key}`);
      mkdirSync(outDir, { recursive: true });
      const result = await compile(file, {
        outPath: join(outDir, "program"),
        outDir,
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
      expect(run.stdout).toBe("rounds 400 rss under 40 MiB\n");
    });
  },
);
