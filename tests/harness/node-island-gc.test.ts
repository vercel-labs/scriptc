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
 *  - A native AbortSignal's twin in the island is collected with it, and
 *    lives while either side holds the signal (tests/fixtures/node-island/gc-signals.mjs).
 *  - A record without a cycle header (its fields cannot form a cycle) that
 *    both sides dropped is collected (tests/fixtures/node-island/gc-records.ts).
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

async function run(
  args: string[],
  env: Record<string, string> = {},
  program: string = binary,
): Promise<Run> {
  const { stdout, stderr } = await execFileAsync(program, args, {
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

  test("AbortSignal twins are collected with their requests", async () => {
    // One native controller per request, its signal handed to the island in
    // a record and dropped by both sides. A twin lives while either side
    // holds its signal, so the ten controllers the program keeps still reach
    // the island's listeners at the end, and nothing else is left.
    const dir = join(outDir, "gc-signals");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-signals.mjs"), {
      outPath: join(dir, "gc-signals"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    // Each run ends with two full collections (the fixture's second
    // argument), so what it holds at exit is what the program keeps and not
    // what the iterations since V8's last own collection made. That number
    // is V8's schedule, not the collector's work: one collection that frees
    // nothing (every export younger than its marking) lowers the bridge's
    // estimate of an export's size, and the next one comes 85,000 exports
    // later (measured: 2 of 120 runs with forty at once held 85,519 at exit
    // instead of 500 to 33,000).
    const collections = "2";
    const small = await run(["10000", collections], {}, result.binaryPath);
    const large = await run(["100000", collections], {}, result.binaryPath);
    // Requests, aborts the island's listeners saw, and the signals the
    // island holds that aborted: the two that follow a kept controller.
    expect(small.stdout).toBe("10000 20 2/6 0\n");
    expect(large.stdout).toBe("100000 110 2/6 0\n");
    for (const r of [small, large]) expect(r.totals["analyzed"]).toBe(r.totals["major"]);
    // V8 scheduled collections of its own, by the exports' size, before the
    // forced ones (14 to 20 of them for 300,000 exports).
    expect(large.totals["major"]).toBeGreaterThan(Number(collections));
    // Three exports per iteration: the options record and the signal the
    // program made, and the native signal that stands for the island's. All
    // of them are gone after the collections, whatever the count. What is
    // left is 18 exports: the signals of the ten controllers the program
    // keeps, the four the island holds, and the two it holds through
    // AbortSignal.any with the signal each of those follows (some runs hold
    // one more). A twin that is not collected with its request leaves one
    // export per iteration.
    const kept = 32;
    for (const [r, n] of [
      [small, 10_000],
      [large, 100_000],
    ] as const) {
      expect(r.totals["held exports"], `held exports of ${n}`).toBeLessThan(kept);
      expect(r.totals["representatives"], `representatives of ${n}`).toBeLessThan(kept);
      expect(r.totals["freed exports"], `freed exports of ${n}`).toBeGreaterThan(3 * n - kept);
    }
    // The measure sees what is not collected: with the cross-heap collector
    // off every export is a root, and the same run holds all of them.
    const leaked = await run(
      ["10000", collections],
      { SCRIPTC_NODE_ISLANDS_GC: "off" },
      result.binaryPath,
    );
    expect(leaked.stdout).toBe(small.stdout);
    expect(leaked.totals["held exports"]).toBeGreaterThanOrEqual(3 * 10_000);
  }, 600_000);

  test("records without a cycle header are collected with their requests", async () => {
    // A typed record of a number and a string per request, handed to the
    // island and dropped by both sides. The walk before a major GC cannot
    // enter such a record (it has no trace function) and counts the one
    // reference its capsule holds: a record nothing else holds is not a
    // root. The ten the program keeps keep their identity in the island's
    // WeakMap, and the four the island holds stay alive.
    const dir = join(outDir, "gc-records");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-records.ts"), {
      outPath: join(dir, "gc-records"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const large = await run(["200000"], {}, result.binaryPath);
    expect(large.stdout).toBe(
      "200000 1288890 r10,r11,r12,r13 10/10 1000,1001,1002,1003,1004,1005,1006,1007,1008,1009\n",
    );
    expect(large.totals["analyzed"]).toBe(large.totals["major"]);
    // One export per iteration. V8 schedules a major GC per 32k of them:
    // what is left is what the last interval made, where every record used
    // to stay a root.
    expect(large.totals["freed exports"]).toBeGreaterThan(200_000 - 70_000);
    expect(large.totals["held exports"]).toBeLessThan(70_000);
  }, 600_000);

  test("child processes an island started and typed code used are collected with their listeners", async () => {
    // Each child is adopted into a ChildProcess slot and its listeners
    // capture it (tests/fixtures/node-island/gc-children.ts): the island's
    // ChildProcess, the listener functions and the native child of every
    // child that closed are freed, so what stays alive does not depend on
    // how many came and went.
    const dir = join(outDir, "gc-children");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-children.ts"), {
      outPath: join(dir, "gc-children"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const [few, many] = sanitize ? [200, 2000] : [400, 6000];
    const small = await run([String(few)], {}, result.binaryPath);
    const large = await run([String(many)], {}, result.binaryPath);
    const expected = (n: number): string => {
      let bytes = 0;
      let codes = 0;
      for (let i = 0; i < n; i++) {
        bytes += String(i).length + 1;
        codes += 2 * (i % 3);
      }
      return `closed ${n} bytes ${bytes} codes ${codes} kept 0\n`;
    };
    expect(small.stdout).toBe(expected(few));
    expect(large.stdout).toBe(expected(many));
    for (const r of [small, large]) {
      expect(r.totals["analyzed"]).toBe(r.totals["major"]);
      // The program ends with full collections. Each child made four
      // exports (its three listeners and the function that releases them
      // when the child closes) and one import; what is left is what the
      // program keeps and at most the last batches of children, whatever
      // the number of children (measured: 2 exports after 400 and after
      // 6,000 children, 24,000 freed).
      expect(r.totals["held exports"]).toBeLessThan(200);
      expect(r.totals["representatives"]).toBeLessThan(200);
      expect(r.totals["held handles"]).toBeLessThan(50);
      expect(r.totals["import entries"]).toBeLessThan(200);
    }
    expect(large.totals["freed exports"]).toBeGreaterThan(4 * many - 200);
  }, 900_000);

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

  test("program errors that crossed into the island are freed when both sides drop them", async () => {
    // Each iteration sends four program errors into the island (one V8
    // Error each, held through the export table, and two callbacks) and
    // keeps none. The runtime's error-view cache holds every error's view
    // and the error until nothing else does, and the export table's
    // collector must not take that for a holder: the resident memory of
    // 300,000 iterations stays within a factor of 1.5 (plus 32 MiB) of
    // 100,000.
    const dir = join(outDir, "gc-native-errors");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-native-errors.mjs"), {
      outPath: join(dir, "gc-native-errors"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const crossed = async (n: number): Promise<Run> => {
      const { stdout, stderr } = await execFileAsync(result.binaryPath, [String(n)], {
        cwd: fixtures,
        env: { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "gc" },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(stderr).not.toMatch(/used after V8 collected|AddressSanitizer|LeakSanitizer/);
      expect(stdout).toBe(`iterations ${n} checks ${4 * n}\n`);
      const line = /\[node-islands\] gc totals: (.*)/.exec(stderr);
      expect(line).not.toBeNull();
      const totals: Record<string, number> = {};
      for (const m of line![1]!.matchAll(/([a-z ]+?) (\d+(?:\.\d+)?)(?: ms)?(?:,|$)/g))
        totals[m[1]!.trim()] = Number(m[2]);
      return { stdout, stderr, totals, rss: Number(/peak rss (\d+) KiB/.exec(stderr)?.[1]) };
    };
    const [few, many] = sanitize ? [2_000, 20_000] : [100_000, 300_000];
    const small = await crossed(few);
    const large = await crossed(many);
    // Six exports per iteration, nearly all collected: what is alive at
    // exit is what crossed since the last major GC.
    expect(large.totals["analyzed"]).toBe(large.totals["major"]);
    expect(large.totals["freed exports"]).toBeGreaterThan((sanitize ? 0.5 : 0.9) * 6 * many);
    expect(large.totals["held exports"]).toBeLessThan(0.1 * 6 * many + 20_000);
    // ASan's quarantine makes the sanitized lane's resident set meaningless.
    if (!sanitize) expect(large.rss).toBeLessThan(small.rss * 1.5 + 32 * 1024);
  }, 600_000);

  test("island errors the program caught are released", async () => {
    // A caught island error has a native view pinned to its island handle,
    // and the runtime's error-view cache holds the view once the program
    // read it as a dynamic value. Neither may keep the other's entry: the
    // resident memory of 300,000 caught errors stays within a factor of
    // 1.5 (plus 32 MiB) of 100,000.
    const dir = join(outDir, "gc-island-errors");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "gc-island-errors.mjs"), {
      outPath: join(dir, "gc-island-errors"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const caught = async (n: number): Promise<{ rss: number; imports: number }> => {
      const { stdout, stderr } = await execFileAsync(result.binaryPath, [String(n)], {
        cwd: fixtures,
        env: { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "gc" },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(stderr).not.toMatch(/used after V8 collected|AddressSanitizer|LeakSanitizer/);
      expect(stdout).toBe(`iterations ${n} checks ${n}\n`);
      return {
        rss: Number(/peak rss (\d+) KiB/.exec(stderr)?.[1]),
        imports: Number(/import entries (\d+)/.exec(stderr)?.[1]),
      };
    };
    const [few, many] = sanitize ? [5_000, 15_000] : [100_000, 300_000];
    const small = await caught(few);
    const large = await caught(many);
    // The island objects still imported at exit do not grow with the errors
    // caught (each unreleased error keeps its V8 error imported).
    expect(small.imports).toBeLessThan(2_000);
    expect(large.imports).toBeLessThan(2_000);
    // ASan's quarantine makes the sanitized lane's resident set meaningless.
    if (!sanitize) expect(large.rss).toBeLessThan(small.rss * 1.5 + 32 * 1024);
  }, 600_000);
});
