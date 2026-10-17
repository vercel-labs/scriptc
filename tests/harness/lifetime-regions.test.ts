/* Lifetime regions (@scriptc/experimental LifetimeRegion): the corpus
 * programs pin Node.js parity; this suite runs the same programs with
 * SCRIPTC_REGION_STATS=1 and checks what the runtime did with each region:
 * freed, kept while something outside still refers into it, or pinned by
 * publication. A program that releases a region while an outside
 * reference survives must keep it (and keep working), never free it.
 * SCRIPTC_SAN=1 builds with ASan and the RC audit, where freed regions
 * stay mapped without access, so any use of a freed object faults. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const corpus = join(import.meta.dirname, "../corpus");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Stats {
  /** "<region> freed|kept|pinned" per release attempt, in order (one thread). */
  attempts: string[];
  /** Per-thread summaries, sorted. */
  summaries: string[];
  /** SCRIPTC_REGION_DEBUG's report lines, in order. */
  report: string[];
  /** Per thread, the cycle-collector passes over its heap that releases
   * needed, sorted. */
  heapPasses: number[];
  stdout: string;
}

async function run(
  program: string,
  env: Record<string, string> = {},
  optimization?: "dev",
): Promise<Stats> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-regions-"));
  try {
    const result = await compile(join(corpus, program), {
      backend: "llvm",
      sanitize,
      ...(optimization ? { optimization } : {}),
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) throw new Error("compile failed");
    const { stdout, stderr } = await exec(result.binaryPath, [], {
      env: { ...process.env, SCRIPTC_REGION_STATS: "1", ...env },
      timeout: 120_000,
    });
    const stats: Stats = { attempts: [], summaries: [], report: [], heapPasses: [], stdout };
    for (const line of stderr.split("\n")) {
      if (line === "" || line.startsWith("scriptc RC audit skipped:")) continue;
      const attempt = /^scriptc region (\d+): (freed|kept|pinned)\b/.exec(line);
      const passes = /^scriptc region heap passes: (\d+)$/.exec(line);
      if (attempt) stats.attempts.push(`${attempt[1]} ${attempt[2]}`);
      else if (passes) stats.heapPasses.push(Number(passes[1]));
      else if (line.startsWith("scriptc regions: ")) stats.summaries.push(line.slice(17));
      else if (
        /^scriptc region \d+: -?\d+ references from outside keep it:$/.test(line) ||
        line.startsWith("  ")
      )
        stats.report.push(line);
      // A region whose free left counted references would print here.
      else if (!/^==\d+==WARNING: ASan doesn't fully support makecontext/.test(line))
        throw new Error(`unexpected stderr line: ${line}`);
    }
    stats.summaries.sort();
    stats.heapPasses.sort((a, b) => a - b);
    return stats;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

const summary = (created: number, freed: number, pinned = 0, released = created): string =>
  `${created} created, ${released} released, ${freed} freed, ${pinned} pinned, ${released - freed - pinned} kept`;

/** Every region was kept by an outside reference first, then freed. */
function keptThenFreed(attempts: string[], regions: number[]): void {
  for (const id of regions) {
    const own = attempts.filter((a) => a.startsWith(`${id} `));
    expect(own[0], `region ${id}`).toBe(`${id} kept`);
    expect(own.at(-1), `region ${id}`).toBe(`${id} freed`);
  }
}

describe.skipIf(process.platform === "win32")("lifetime regions", { timeout: 240_000 }, () => {
  test("SCRIPTC_REGION_DEBUG names the field holding an owned object referenced from outside", async () => {
    // The reports are compiled into dev runtimes (and RC-audit ones).
    const stats = await run("5703-lifetime-region-debug.ts", { SCRIPTC_REGION_DEBUG: "1" }, "dev");
    expect(stats.stdout).toBe("s1 2 3 3 s0,s1,s2\n2\n");
    keptThenFreed(stats.attempts, [1]);
    expect(stats.report[0]).toMatch(/^scriptc region 1: \d+ references from outside keep it:$/);
    // `held` refers to a symbol directly: the walk sees only the chunk.
    expect(stats.report).toContainEqual(
      expect.stringMatching(
        /^ {2}\d+ not found by the walk, to objects in a chunk holding \w+(, \w+)*$/,
      ),
    );
    // `maps` holds the map the region's Unit owns.
    expect(stats.report).toContain(
      "  a map or set held by Unit.byName, with 2 references, 1 of them from what the region owns",
    );
  });

  test("generations free each released file and checker region once unreferenced", async () => {
    const stats = await run("5010-lifetime-region-generations.ts");
    // The module's file table still holds the last generation's files.
    expect(stats.summaries).toEqual([summary(19, 15)]);
    // A replaced file's region is kept until the checker that refers to it
    // is released.
    keptThenFreed(stats.attempts, [2, 3, 4, 1]);
  });

  test("outside references keep released regions until they are dropped", async () => {
    const stats = await run("5011-lifetime-region-outside-references.ts");
    expect(stats.summaries).toEqual([summary(7, 7)]);
    keptThenFreed(stats.attempts, [1, 2, 3, 4, 5, 6]);
    expect(stats.stdout).toContain("module variable: a1>a2>a3");
  });

  test("owned graphs of every shape and owned cycles are freed", async () => {
    for (const [program, regions] of [
      ["5012-lifetime-region-shapes.ts", 6],
      ["5017-lifetime-region-cycles.ts", 5],
      ["5018-lifetime-region-hierarchies.ts", 4],
      ["5020-lifetime-region-large.ts", 4],
    ] as const) {
      const stats = await run(program);
      expect(stats.summaries, program).toEqual([summary(regions, regions)]);
      expect(stats.attempts, program).toEqual(
        Array.from({ length: regions }, (_, i) => `${i + 1} freed`),
      );
      // Owned cycles go without a pass over the heap. In 5017 each region is
      // also referred to by a dead cycle outside it, which only such a pass
      // finds.
      expect(stats.heapPasses, program).toEqual([
        program === "5017-lifetime-region-cycles.ts" ? regions : 0,
      ]);
    }
  });

  test("async work, nesting, holders the walk does not inspect and handles", async () => {
    // Work that resumes after an await allocates in its region, which is
    // freed once that work has finished.
    expect((await run("5013-lifetime-region-async.ts")).summaries).toEqual([summary(7, 7)]);
    const nesting = await run("5014-lifetime-region-nesting.ts");
    expect(nesting.summaries).toEqual([summary(4, 2)]);
    const opaque = await run("5021-lifetime-region-opaque-holders.ts");
    expect(opaque.summaries).toEqual([summary(2, 2)]);
    keptThenFreed(opaque.attempts, [1]);
    expect((await run("5019-lifetime-region-values.ts")).summaries).toEqual([summary(2, 0)]);
  });

  test("regions carried across await by concurrent requests are freed", async () => {
    const stats = await run("5023-lifetime-region-await.ts");
    expect(stats.summaries).toEqual([summary(15, 15)]);
    // Each request's region (eight interleaved ones, then a later one) is
    // freed when the request releases it; a region released while its work
    // is pending, or while work it started is still running, is freed once
    // that work ends, without an attempt that keeps it.
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15])
      expect(
        stats.attempts.filter((a) => a.startsWith(`${id} `)),
        `region ${id}`,
      ).toEqual([`${id} freed`]);
    // The nested region is referenced by the outer one until that is freed;
    // the escaping result keeps its region until the cache lets go.
    keptThenFreed(stats.attempts, [10, 14]);
  });

  test("weak keys of freed regions do not survive", async () => {
    const stats = await run("5016-lifetime-region-weak-keys.ts");
    expect(stats.summaries).toEqual([summary(5, 4)]);
    expect(stats.stdout.split("\n").filter((l) => l.includes("fresh 50"))).toHaveLength(5);
  });

  test("published regions are pinned; worker regions belong to their threads", async () => {
    const publish = await run("5015-lifetime-region-publish.ts");
    // Main thread: the published region is pinned, the others are freed;
    // the worker frees all but its last region, still referenced at exit.
    expect(publish.summaries).toEqual([summary(3, 2), summary(3, 2, 1)].sort());
    expect(publish.attempts).toContain("1 pinned");
    const workers = await run("5022-lifetime-region-workers.ts");
    expect(workers.summaries).toEqual([summary(6, 6), summary(8, 8), summary(8, 8), summary(8, 8)]);
    expect(workers.heapPasses).toEqual([0, 0, 0, 0]);
  });
});
