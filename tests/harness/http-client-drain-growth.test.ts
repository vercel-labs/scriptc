/* A client request's socket-drain bridge at steady state. A corked write at
 * or above the message's 64 KiB high-water mark answers false and registers a
 * one-shot socket-'drain' listener whose closure retains the request; when the
 * write flushes without a later socket drain, the bridge otherwise stays on the
 * pooled socket and every completed exchange keeps its request, response,
 * headers and context alive. The request settles at 'close', which takes the
 * bridge off the socket's list, so repeated pooled uploads stay bounded.
 *
 * LeakSanitizer and the exit audit cannot see it: the exit teardown drops every
 * socket's listener list first, so the retention has to be measured while the
 * program runs. Each exchange carries its own 8 KiB path, and the resident size
 * after 3000 exchanges stays under 20 MiB when the settle disarms the bridge
 * and grows past 40 MiB when it does not. AddressSanitizer's quarantine keeps
 * freed blocks mapped, so the bound only applies outside the sanitized lane.
 * Linux only (the resident size of a process is a Linux measurement here). */
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
  "http client drain bridge retention at steady state",
  () => {
    test("3000 pooled large uploads stay bounded", { timeout: 600_000 }, async () => {
      const file = join(repoRoot, "tests/fixtures/http-client-drain-growth/main.ts");
      const key = createHash("sha256")
        .update(file)
        .update(readFileSync(file))
        .update("plain")
        .digest("hex")
        .slice(0, 16);
      const outDir = join(cacheDir, `http-client-drain-growth-${key}`);
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
      expect(run.stdout).toBe("exchanges 3000 rss under 20 MiB\n");
    });
  },
);
