/* A settled server keeps its persistent 'close' listeners so a later
 * close() re-emits into them, as Node's does. A listener that captures its
 * own server closes an ownership cycle (server → closure → server) the
 * reference count cannot break and the cycle collector cannot see, so the
 * settle drops those listeners; otherwise every request-triggered temporary
 * server and everything it captured stays allocated until process exit.
 *
 * LeakSanitizer and the exit audit cannot see it: the exit teardown drops
 * every server's listener list first, so the retention has to be measured
 * while the program runs. Each temporary server carries its own 32 KiB
 * payload, opened in waves so only one wave is alive at a time; the resident
 * size after 2000 of them stays under 40 MiB when the settle drops the
 * self-capturing listeners and grows past it when it does not. Linux only
 * (the resident size of a process is a Linux measurement here), and skipped
 * in the sanitized lane, whose quarantine keeps freed blocks mapped. */
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
  "server close listeners that capture their server",
  () => {
    test("2000 temporary servers stay bounded", { timeout: 600_000 }, async () => {
      const file = join(repoRoot, "tests/fixtures/net-server-close-listener-cycle/main.ts");
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("plain")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `net-server-close-listener-cycle-${key}`);
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
      // Each closed server's payload: 32768 - i bytes, i in [0, 2000); the
      // listener's `listening` read is false at 'close' in both runtimes.
      const payload = 2000 * 32 * 1024 - (2000 * 1999) / 2;
      expect(run.stdout).toBe(`servers 2000 payload ${payload} rss under 40 MiB\n`);
    });
  },
);
