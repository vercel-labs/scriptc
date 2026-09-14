/* Windows console code page initialization test.
 * Verifies that native binaries initialize the console output and input code
 * pages to CP_UTF8 (65001) in scr_init(), preventing mojibake in terminals.
 * Refs #321.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

describe.runIf(process.platform === "win32")("Windows console UTF-8 code page initialization", () => {
  test("native binary sets console code page to 65001", async () => {
    const outDir = join(cacheDir, "win-console-utf8");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/corpus/2858-console-utf8.ts"), {
      outPath: join(outDir, "console-utf8.exe"),
      outDir,
      backend: "c",
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }

    const binary = join(outDir, "console-utf8.exe");
    const cmdResult = spawnSync("cmd.exe", ["/c", `chcp 437 >nul & "${binary}" & chcp`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect(cmdResult.status).toBe(0);
    expect(cmdResult.stdout).toContain("unicode box: ─── · › ☕");
    expect(cmdResult.stdout).toMatch(/65001/);
  });
});
