/* Cross-heap cycle collection (scope-B NI-8) where a differential corpus
 * program cannot show it. tests/fixtures/node-island/gc-cycles.mjs makes
 * and drops one cross-heap cycle of each shape per iteration and keeps some
 * reachable from one side only; the corpus (6890-6895) pins the same shapes
 * against Node.
 *  - The memory and the handles a program holds do not grow with the
 *    number of cycles it dropped (10k against 100k iterations).
 *  - Forcing full collections throughout (and, in the sanitized lane,
 *    under ASan) frees nothing still reachable: the run prints exactly
 *    what a run with the collector switched off prints, and never trips the
 *    bridge's use-after-collection check.
 *  - A native object the program keeps, which crosses in a capsule only
 *    the export table holds, keeps its representative: the island's weak
 *    maps still find it (tests/fixtures/node-island/gc-capsule).
 *  - Exports the island keeps for the whole run schedule no major GCs of
 *    their own once a GC found them live (tests/fixtures/node-island/gc-held.mjs).
 * Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtures = join(repoRoot, "tests/fixtures/node-island");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-gc");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

interface Run {
  stdout: string;
  stderr: string;
  totals: Record<string, number>;
  rss: number;
}

let binary = "";

async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    cwd: fixtures,
    env: { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "gc", ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(stderr).not.toMatch(/used after V8 collected|AddressSanitizer|LeakSanitizer/);
  const line = /\[node-islands\] gc totals: (.*)/.exec(stderr);
  expect(line).not.toBeNull();
  const totals: Record<string, number> = {};
  for (const m of line![1]!.matchAll(/([a-z ]+?) (\d+(?:\.\d+)?)(?: ms)?(?:,|$)/g))
    totals[m[1]!.trim()] = Number(m[2]);
  const rss = Number(/peak rss (\d+) KiB/.exec(stderr)?.[1]);
  return { stdout, stderr, totals, rss };
}

describe.skipIf(skip)("Node island cross-heap cycles", () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(fixtures, "gc-cycles.mjs"), {
      outPath: join(outDir, "gc-cycles"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    binary = result.binaryPath;
  }, 300_000);

  test("memory and held handles stay flat as dropped cycles grow", async () => {
    const small = await run(["10000"]);
    const large = await run(["100000"]);
    for (const r of [small, large]) {
      expect(r.stdout).toMatch(/^sum \d+ check \d+ watched alive (\d+) of \1\n$/);
      // Every major GC was analyzed, and the collector freed nearly every
      // dropped cycle (seven representatives and five imports each).
      expect(r.totals["analyzed"]).toBe(r.totals["major"]);
    }
    expect(large.totals["freed exports"]).toBeGreaterThan(0.99 * 7 * 100_000 - 1000);
    expect(large.totals["freed imports"]).toBeGreaterThan(0.99 * 5 * 100_000 - 1000);
    // What stays alive is what the program keeps, the same for both.
    for (const key of ["held exports", "held handles", "representatives", "import entries"])
      expect(large.totals[key], key).toBe(small.totals[key]);
    expect(large.totals["held handles"]).toBeLessThan(200);
    // Peak memory does not grow with the cycles dropped (ASan's quarantine
    // makes the sanitized lane's resident set meaningless).
    if (!sanitize) expect(large.rss).toBeLessThan(small.rss * 1.5 + 32 * 1024);
  }, 600_000);

  test("forced collections free nothing still reachable from either side", async () => {
    const n = sanitize ? "2000" : "6000";
    const off = await run([n, "gc"], { SCRIPTC_NODE_ISLANDS_GC: "off" });
    const on = await run([n, "gc"]);
    expect(off.totals["analyzed"]).toBe(0);
    expect(on.totals["analyzed"]).toBe(on.totals["major"]);
    expect(on.totals["major"]).toBeGreaterThan(20);
    expect(on.totals["freed exports"]).toBeGreaterThan(0);
    expect(on.stdout).toMatch(/^sum \d+ check \d+ watched alive (\d+) of \1\n$/);
    expect(on.stdout).toBe(off.stdout);
  }, 600_000);

  test("exports the island keeps do not schedule major GCs of their own", async () => {
    // 200k long-lived representatives. Each export adds to the external
    // memory V8 schedules major GCs by, until a GC finds that the exports
    // made since the previous one were not garbage.
    const dir = join(outDir, "gc-held");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-held.mjs"), {
      outPath: join(dir, "gc-held"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const n = 200_000;
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [String(n)], {
      cwd: fixtures,
      env: { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "gc" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(stdout).toBe(`kept ${n} sum ${(n * (n - 1)) / 2}\n`);
    const major = Number(/\[node-islands\] gc totals: major (\d+)/.exec(stderr)?.[1]);
    expect(major).toBeGreaterThan(0);
    expect(major).toBeLessThanOrEqual(3);
  }, 300_000);

  test("a native object the program keeps keeps its identity in island weak maps", async () => {
    // A typed object crosses in a capsule the export table alone holds;
    // the program holds the object itself.
    const dir = join(outDir, "gc-capsule");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-capsule/main.ts"), {
      outPath: join(dir, "main"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, XDG_CACHE_HOME: join(dir, "cache") },
      encoding: "utf8",
    });
    expect(stdout).toBe("remembered\n");
  }, 300_000);
});
