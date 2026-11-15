/* A URLSearchParams sequence row converts its name before its value, and
 * either conversion can throw. A row whose value conversion throws must
 * give back the name it already converted with the rest of the failed
 * construction; otherwise every rejected request retains a request-sized
 * string. The fixture repeats the failing construction and reports the
 * runtime heap growth after a warm-up, so one retained name per round
 * shows up as megabytes.
 *
 * The sanitized lane's allocator reports different figures, so this
 * measures the plain runtime only. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/url-search-params-tuple-errors/main.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(sanitize)(
  "a failed sequence row conversion releases the name it converted",
  { timeout: 300_000 },
  async () => {
    const key = createHash("sha256")
      .update(fixture)
      .update(readFileSync(fixture))
      .update("plain")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `url-search-params-tuple-errors-${key}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(fixture, {
      outPath: join(outDir, "program"),
      outDir,
      backend: "llvm",
    });
    if (!result.ok)
      throw new Error(
        "fixture failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    const run = await execFileAsync(result.binaryPath, [], {
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(run.stderr).toBe("");
    const lines = run.stdout.trim().split("\n");
    const growth = Number(/^growth (-?\d+)$/.exec(lines[0] ?? "")?.[1]);
    expect(Number.isFinite(growth)).toBe(true);
    expect(growth, `heap growth ${growth} KB`).toBeLessThan(1024);
    // Every construction threw the same way.
    expect(lines[1]).toBe("threw 300");
  },
);
