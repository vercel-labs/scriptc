/* inspect with showHidden prints a RegExp's own `[lastIndex]` entry before
 * its other properties, and the number styling that reads
 * inspect.styles.number runs program code while the render still holds a
 * borrowed property. The fixture has the accessor delete that property; the
 * render must hold the entry before the accessor can run, so the fixture
 * runs under AddressSanitizer and a render that reads a released entry
 * reports it.
 *
 * Runs in the SCRIPTC_SAN=1 lane on Linux. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/inspect-regexp-styles/main.mjs");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(!sanitize || process.platform !== "linux")(
  "a style accessor that deletes a RegExp property leaves a live entry to print",
  { timeout: 300_000 },
  async () => {
    const key = createHash("sha256")
      .update(fixture)
      .update(readFileSync(fixture))
      .update("san")
      .digest("hex")
      .slice(0, 16);
    const outDir = join(cacheDir, `inspect-regexp-styles-${key}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(fixture, {
      outPath: join(outDir, "program"),
      outDir,
      sanitize: true,
      backend: "llvm",
    });
    if (!result.ok)
      throw new Error(
        "fixture failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    const run = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1" },
      encoding: "utf8",
      timeout: 240_000,
    }).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
    expect(run.stderr).toBe("");
    expect("code" in run ? run.code : 0).toBe(0);
    expect(run.stdout.trim()).toBe("regexp string true");
  },
);
