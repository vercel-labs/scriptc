/* Ordering fidelity of the hosted event loop (scope-B milestone NI-3,
 * design §5.2). Once a scriptc program loads Node, its ticks, promise
 * jobs, timers, immediates and I/O run on Node's loop together with island
 * code's, so the interleaving of both sides must be one Node itself
 * produces. Each program in tests/corpus-node-islands-order/ (the native
 * half in main.ts, the island half interpreted by island.cjs) runs M times
 * under Node, which collects the set of orders Node produces, and N times
 * as a compiled binary; every native run must produce an output in Node's
 * set. Programs whose order is fully determined by the queues produce one
 * output; the I/O races (fs callbacks against busy timers) may produce
 * several, and the native runs must stay within them.
 *
 * A program whose head says `// @order: race` races a timer against I/O
 * whose duration differs between the sides (scriptc's own fs callbacks
 * complete in one turn where Node's readFile takes several; module loading
 * on the first call into Node takes longer than in a Node process; a job on
 * libuv's thread pool, such as zlib's, can finish before or after a 2 ms
 * timer depending on the host), or two
 * equal timers armed on either side of an island call, which a millisecond
 * boundary between them (likely in a sanitized build) puts in different
 * loop turns, so Node permits orders it rarely produces in M runs. Its
 * native runs must
 * produce the lines of one of Node's outputs, in any order; the report
 * still records whether the order itself was among Node's.
 *
 * The s* programs pin the one-time switch: work already pending in the
 * program's queues (timers, immediates, ticks, microtasks, promise jobs,
 * fs callbacks, an open socket) at the moment Node loads, in the main
 * body, a timer, an immediate and a promise job.
 *
 * Needs a libnode pack in SCRIPTC_LIBNODE whose Node version is the `node`
 * on PATH. NODE_ISLAND_ORDER_NODE_RUNS (default 20) and
 * NODE_ISLAND_ORDER_NATIVE_RUNS (default 3) set M and N;
 * NODE_ISLAND_ORDER_REPORT names a JSON file for the per-program counts. */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const programsDir = join(repoRoot, "tests/corpus-node-islands-order");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-order");
const pack = process.env["SCRIPTC_LIBNODE"];
const skip = (process.platform !== "linux" && process.platform !== "darwin") || !pack;
const nodeRuns = Number(process.env["NODE_ISLAND_ORDER_NODE_RUNS"] ?? 20);
const nativeRuns = Number(process.env["NODE_ISLAND_ORDER_NATIVE_RUNS"] ?? 3);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const programs = existsSync(programsDir)
  ? readdirSync(programsDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(programsDir, entry.name, "main.ts")),
      )
      .map((entry) => entry.name)
      .sort()
  : [];

/** Linux ASan's once-per-process warning at the first context switch (the
 * runtime's fibers and Node's stack): not program output. */
const ASAN_SWAP = /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm;

/** One run's observable outcome: stdout, stderr and the exit status. */
async function outcome(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr: raw } = await execFileAsync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const stderr = raw.replace(ASAN_SWAP, "");
    return `${stdout}${stderr === "" ? "" : `[stderr]\n${stderr}`}[exit 0]`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown; signal?: unknown };
    if (typeof e.code !== "number") return `[failed ${String(e.signal ?? e.code)}]`;
    const stderr = (e.stderr ?? "").replace(ASAN_SWAP, "");
    return `${e.stdout ?? ""}${stderr ? `[stderr]\n${stderr}` : ""}[exit ${e.code}]`;
  }
}

const report: Record<string, { node: Record<string, number>; native: Record<string, number> }> = {};

afterAll(() => {
  const path = process.env["NODE_ISLAND_ORDER_REPORT"];
  if (path) writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
});

describe.skipIf(skip)(`Node island ordering (${programs.length} programs)`, () => {
  test.for(programs)("%s", { timeout: 600_000 }, async (name) => {
    const main = join(programsDir, name, "main.ts");
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const built = await compile(main, { outPath: join(dir, "program"), outDir: dir, sanitize });
    if (!built.ok)
      throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const node: Record<string, number> = {};
    for (let i = 0; i < nodeRuns; i++) {
      const out = await outcome("node", [main]);
      node[out] = (node[out] ?? 0) + 1;
    }
    const native: Record<string, number> = {};
    for (let i = 0; i < nativeRuns; i++) {
      const out = await outcome(built.binaryPath, []);
      native[out] = (native[out] ?? 0) + 1;
    }
    report[name] = { node, native };
    const race = readFileSync(main, "utf8").split("\n", 3).includes("// @order: race");
    const lines = (out: string): string => out.split("\n").sort().join("\n");
    if (race) {
      const nodeLines = Object.keys(node).map(lines);
      for (const out of Object.keys(native))
        expect(nodeLines, `native lines not produced by Node in ${nodeRuns} runs`).toContain(
          lines(out),
        );
      return;
    }
    for (const out of Object.keys(native)) {
      expect(Object.keys(node), `native output not produced by Node in ${nodeRuns} runs`).toContain(
        out,
      );
    }
  });
});
