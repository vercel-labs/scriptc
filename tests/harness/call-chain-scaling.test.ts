/* Compile time stays polynomial in the length of a call chain whose root
 * cannot be lowered. Lowering a call probes its receiver and then lowers it
 * again for the form it picks, which doubled the work at every link: a
 * 25-link builder chain on a refused import (a command-line parser
 * configured in one expression) never finished. A refused probe is not
 * repeated now; this chain is far past where the doubling was survivable. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

test("a 40-link chain on a refused import is reported and the analysis ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-call-chain-"));
  try {
    const entry = join(dir, "refused.ts");
    let chain = "(start as unknown as Builder)";
    for (let i = 0; i < 40; i++) chain += `\n  .step(${i})`;
    writeFileSync(join(dir, "data.json"), '{ "start": 1 }\n');
    writeFileSync(
      entry,
      `import { start } from "./data.json";
interface Builder { step(n: number): Builder; done(): number }
console.log(${chain}
  .done());
`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [cli, "coverage", entry, "--print=diagnostics"],
      { env: { ...process.env, SCRIPTC_NO_CACHE: "1" }, maxBuffer: 64 * 1024 * 1024 },
    ).catch((error: { stdout: string }) => error);
    const report = JSON.parse(stdout) as { diagnostics: { code: string; message: string }[] };
    const codes = report.diagnostics.map((d) => d.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).not.toContain("SC9001");
    expect(report.diagnostics.some((d) => d.message.includes("lowering attempts"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
