/* linearBuckets reports one entry per histogram bucket, so its cost follows
 * the buckets a histogram has, not the reporting levels a small step asks
 * for: one large observation exported with a step of 1 must finish quickly.
 * Node keeps no such separation (it walks every level), so this cannot be a
 * differential corpus program. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const PROGRAM = `const { createHistogram } = require("node:perf_hooks");
const histogram = createHistogram({ lowest: 1, highest: 2000000000, figures: 2 });
histogram.record(2000000000);
const start = Date.now();
const buckets = histogram.linearBuckets(1);
console.log("keys", buckets.size > 0, "quick", Date.now() - start < 5000);
`;

async function run(source: string): Promise<{ stdout: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-linear-buckets-"));
  const entry = join(outDir, "main.cjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", code: -1 };
  try {
    const { stdout } = await execFileAsync(result.binaryPath, [], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; code?: number };
    return { stdout: failed.stdout ?? "", code: failed.code ?? -1 };
  }
}

test("a small export step over a large observation walks buckets, not levels", async () => {
  const { stdout, code } = await run(PROGRAM);
  expect(code).toBe(0);
  expect(stdout).toContain("keys true quick true");
}, 300_000);
