/* Node island conformance: a program that imports an npm package must print
 * the same bytes and exit the same way however the package runs.
 *
 * Every program (island-conformance/cases.ts) runs three ways:
 *
 * - under Node, the oracle;
 * - as its default build (`default`): what `scriptc build` produces with no
 *   flags, the packages compiled natively unless the automatic policy already
 *   runs one in a Node island;
 * - once per imported package with that package forced into a Node island
 *   (`island:<package>`, the build's `--node-island=<package>`).
 *
 * stdout, the exit status and (for a program that compares it) stderr of
 * each way are compared with Node's for every argv list. The lane measures
 * the island, so two differences are not charged to it:
 *
 * - a default build that runs no package in a Node island and differs from
 *   Node is the native tier's difference, which the npm suite and the corpus
 *   pin; its test is skipped with a note;
 * - a forced island build whose result equals the default build's inherits
 *   the default build's difference.
 *
 * island-conformance/known-failures.json lists every island way that does
 * not match Node, keyed by program and way, with a category and a signature
 * (a default build is listed when the automatic policy ran a package of the
 * program in an island: that island is what failed). The lane
 * passes when exactly the listed failures occur. It fails on a failure the
 * list does not have, on a listed failure that changed, and on a listed
 * failure that no longer occurs, so the list only shrinks when a fix removes
 * its entry and only grows by a deliberate edit. Its size by category is the
 * scoreboard for island robustness (island-conformance/scoreboard.mjs). An
 * entry marked `unstable` is a race: it may match Node in one run and fail
 * in the next, so it is pinned by category when it fails and kept by hand.
 *
 * The lane is opt-in: SCRIPTC_ISLAND_CONFORMANCE=1 runs it, =update rewrites
 * the entries of the programs it ran. It needs a libnode pack
 * (SCRIPTC_LIBNODE) and pins Linux x64 results. Without the variable only
 * the list's own consistency is checked.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { conformanceCases, type ConformanceCase } from "./island-conformance/cases.js";
import { libnodePack } from "./libnode.js";
import { normalizeNodeVersion, runBinary, sharedFrames, type RunResult } from "./npm-suite.js";
import { shardSelect, shardSuffix } from "./shard.js";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/island-conformance");
const knownPath = join(import.meta.dirname, "island-conformance/known-failures.json");
const mode = process.env["SCRIPTC_ISLAND_CONFORMANCE"];
const update = mode === "update";
const enabled = mode === "1" || update;

/** How a way differs from Node:
 * - build: the compile refuses the program;
 * - not-islanded: the build accepted `--node-island=<package>` and ran the
 *   package natively all the same;
 * - crash: the program died on a signal;
 * - exit: another exit status;
 * - stdout: the same exit status and other output (a silent divergence when
 *   stderr matches too);
 * - stderr: only stderr differs. */
type Category = "build" | "not-islanded" | "crash" | "exit" | "stdout" | "stderr";

interface Failure {
  category: Category;
  /** The diagnostic codes of a refused build, or the first differing line. */
  signature: string;
  /** The argv lists that differ, when the program has more than one. */
  argvs?: string[];
  /** The packages the default build ran in Node islands by itself: a
   * default-build failure with any is an island failure too. */
  autoIslands?: string[];
  /** The failure is a race: some runs match Node, and the line a failing
   * run stops at varies, so the entry only pins the category of a failure
   * when there is one. Set and removed by hand; an update keeps it. */
  unstable?: true;
}

type Known = Record<string, Record<string, Failure>>;

const known = JSON.parse(readFileSync(knownPath, "utf8")) as Known;
const allCases = conformanceCases();

type Built =
  | { ok: true; binary: string; islands: string[] }
  | { ok: false; codes: string[]; text: string };

async function build(c: ConformanceCase, island: string | null): Promise<Built> {
  const key = createHash("sha256")
    .update(c.name)
    .update("\0")
    .update(island ?? "")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(c.entry, {
    outPath: join(outDir, "program"),
    outDir,
    ...(island === null ? {} : { nodeIslands: { islands: [island] } }),
  });
  if (result.ok)
    return { ok: true, binary: result.binaryPath, islands: result.islands?.packages ?? [] };
  return {
    ok: false,
    codes: [...new Set(result.diagnostics.map((d) => d.code))].sort(),
    text: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
  };
}

/** One line of output as the list records it: machine paths replaced, and
 * cut to a length that still names the failure. */
function signatureLine(line: string): string {
  return (
    line
      .replaceAll(repoRoot, "<repo>")
      .replace(/(?:\/[^\s"'`/:()]+)+\/scriptc\/node-islands\/[0-9a-f]{64}/g, "<island-tree>")
      // Identifiers the compiler derives from a machine's paths.
      .replace(/\d{6,}/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160)
  );
}

/** The line that names how `got` differs from `want`: of the lines `want`
 * does not have at the same position, the first that reports an error, else
 * the first with any text. */
function firstDifference(got: string, want: string): string {
  const a = got.split("\n");
  const b = want.split("\n");
  let first: string | null = null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) {
      first ??= signatureLine(`<end of output; Node: ${b[i] ?? ""}>`);
      break;
    }
    const line = signatureLine(a[i]!);
    if (/\berror\b|Error\b/.test(line)) return line;
    if (line !== "") first ??= line;
  }
  return first ?? "";
}

/** Paths below a node_modules directory, read the same from the program's
 * tree and from the module tree an island ships (node-islands/modules.ts). */
function packagePaths(text: string): string {
  return text.replace(/(?:\/[^\s"'`/:()]+)+\/node_modules\//g, "<root>/node_modules/");
}

interface Streams {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The process id in Node's warnings: `(node:1234) [DEP0040] ...`. */
function processIds(text: string): string {
  return text.replace(/\(node:\d+\)/g, "(node:<pid>)");
}

/** A run's streams with what an island legitimately spells differently made
 * equal on both sides: package paths, process ids, the frames an island's
 * report cannot share with Node's, and the patch release of the embedded
 * Node. */
function comparable(got: RunResult, node: RunResult, island: boolean): [Streams, Streams] {
  if (!island) {
    return [
      {
        exitCode: got.exitCode,
        stdout: got.stdout.toString("latin1"),
        stderr: got.stderr.toString("latin1"),
      },
      {
        exitCode: node.exitCode,
        stdout: node.stdout.toString("latin1"),
        stderr: node.stderr.toString("latin1"),
      },
    ];
  }
  const [gotErr, nodeErr] = normalizeNodeVersion(sharedFrames(got.stderr, node.stderr));
  return [
    {
      exitCode: got.exitCode,
      stdout: packagePaths(got.stdout.toString("utf8")),
      stderr: processIds(packagePaths(gotErr)),
    },
    {
      exitCode: node.exitCode,
      stdout: packagePaths(node.stdout.toString("utf8")),
      stderr: processIds(packagePaths(nodeErr)),
    },
  ];
}

function difference(
  got: RunResult,
  node: RunResult,
  island: boolean,
  compareStderr: boolean,
): { category: Category; signature: string } | null {
  const [a, b] = comparable(got, node, island);
  if (a.exitCode === -1)
    return { category: "crash", signature: firstDifference(a.stderr, b.stderr) };
  if (a.exitCode !== b.exitCode) {
    return {
      category: "exit",
      signature: `exit ${a.exitCode}, Node ${b.exitCode}: ${firstDifference(a.stderr, b.stderr) || firstDifference(a.stdout, b.stdout)}`,
    };
  }
  if (a.stdout !== b.stdout)
    return { category: "stdout", signature: firstDifference(a.stdout, b.stdout) };
  if (compareStderr && a.stderr !== b.stderr)
    return { category: "stderr", signature: firstDifference(a.stderr, b.stderr) };
  return null;
}

function sameRun(a: RunResult, b: RunResult): boolean {
  return a.exitCode === b.exitCode && a.stdout.equals(b.stdout) && a.stderr.equals(b.stderr);
}

/** What one program's ways did: the oracle and the default build are shared
 * by its island tests. */
interface ProgramRuns {
  node: RunResult[];
  built: Built;
  runs: RunResult[] | null;
}

const programs = new Map<string, Promise<ProgramRuns>>();

function programRuns(c: ConformanceCase): Promise<ProgramRuns> {
  let pending = programs.get(c.name);
  if (pending === undefined) {
    pending = (async () => {
      const node: RunResult[] = [];
      for (const argv of c.argvs)
        node.push(await runBinary(process.execPath, [...c.nodeArgs, c.entry, ...argv], c.cwd));
      const built = await build(c, null);
      if (!built.ok) return { node, built, runs: null };
      const runs: RunResult[] = [];
      for (const argv of c.argvs) runs.push(await runBinary(built.binary, argv, c.cwd));
      return { node, built, runs };
    })();
    programs.set(c.name, pending);
  }
  return pending;
}

/** The failure of one way over a program's argv lists, or null: the first
 * differing list names it, and every differing list is recorded. */
function failureOf(
  c: ConformanceCase,
  node: RunResult[],
  runs: RunResult[],
  island: boolean,
  compareStderr: boolean,
  inherited: RunResult[] | null,
): Failure | null {
  let first: { category: Category; signature: string } | null = null;
  const argvs: string[] = [];
  for (let i = 0; i < c.argvs.length; i++) {
    const diff = difference(runs[i]!, node[i]!, island, compareStderr);
    if (diff === null) continue;
    if (inherited !== null && sameRun(runs[i]!, inherited[i]!)) continue;
    first ??= diff;
    argvs.push(c.argvs[i]!.join(" "));
  }
  if (first === null) return null;
  return { ...first, ...(c.argvs.length > 1 ? { argvs } : {}) };
}

/** The default build's failure, and whether it is the native tier's own (no
 * package of the program ran in an island): the lane does not list those. */
async function defaultFailure(
  c: ConformanceCase,
): Promise<{ failure: Failure | null; native: boolean }> {
  const { node, built, runs } = await programRuns(c);
  if (!built.ok)
    return { failure: { category: "build", signature: built.codes.join(",") }, native: true };
  const autoIslands = built.islands.filter((name) => c.packages.includes(name)).sort();
  const failure = failureOf(c, node, runs!, built.islands.length > 0, c.compareStderr, null);
  if (failure === null) return { failure: null, native: false };
  if (autoIslands.length === 0) return { failure, native: true };
  return { failure: { ...failure, autoIslands }, native: false };
}

/** null with `skipped` when the default build already runs the package in
 * an island: the default way is that island's test. */
async function islandFailure(
  c: ConformanceCase,
  name: string,
): Promise<{ failure: Failure | null; skipped: boolean }> {
  const base = await programRuns(c);
  if (base.built.ok && base.built.islands.includes(name)) return { failure: null, skipped: true };
  const built = await build(c, name);
  if (!built.ok) {
    // The same refusal as the default build's is not the island's.
    if (!base.built.ok && base.built.codes.join(",") === built.codes.join(","))
      return { failure: null, skipped: false };
    return { failure: { category: "build", signature: built.codes.join(",") }, skipped: false };
  }
  if (!built.islands.includes(name))
    return {
      failure: {
        category: "not-islanded",
        signature: `islands: ${built.islands.join(",") || "none"}`,
      },
      skipped: false,
    };
  const runs: RunResult[] = [];
  for (const argv of c.argvs) runs.push(await runBinary(built.binary, argv, c.cwd));
  return {
    failure: failureOf(c, base.node, runs, true, c.compareStderr, base.runs),
    skipped: false,
  };
}

/** What the lane observed, by program and way (null: the way matches). */
const observed = new Map<string, Map<string, Failure | null>>();

function record(program: string, way: string, failure: Failure | null): void {
  let ways = observed.get(program);
  if (ways === undefined) observed.set(program, (ways = new Map()));
  ways.set(way, failure);
}

function check(program: string, way: string, failure: Failure | null): void {
  record(program, way, failure);
  if (update) return;
  const listed = known[program]?.[way] ?? null;
  if (listed?.unstable === true) {
    if (failure !== null)
      expect(failure.category, `${program} (${way}) fails in another way now`).toBe(
        listed.category,
      );
    return;
  }
  if (listed === null && failure !== null)
    expect.fail(
      `${program} (${way}) does not match Node and known-failures.json does not list it:\n${JSON.stringify(failure, null, 2)}`,
    );
  if (listed !== null && failure === null)
    expect.fail(
      `${program} (${way}) matches Node now: remove its entry from known-failures.json (SCRIPTC_ISLAND_CONFORMANCE=update)`,
    );
  expect(
    failure,
    `${program} (${way}) fails differently from its known-failures.json entry`,
  ).toEqual(listed);
}

test("every known failure names a program and a way the lane runs", () => {
  const ways = new Map(
    allCases.map((c) => [c.name, new Set(["default", ...c.packages.map((p) => `island:${p}`)])]),
  );
  const stale: string[] = [];
  for (const [program, entries] of Object.entries(known))
    for (const way of Object.keys(entries))
      if (ways.get(program)?.has(way) !== true) stale.push(`${program} ${way}`);
  expect(stale).toEqual([]);
});

const pinned = process.platform === "linux" && process.arch === "x64";
const cases = shardSelect(allCases, (c) => c.name);

describe.skipIf(!enabled || !pinned || libnodePack() === null)(
  `island conformance (${cases.length} programs${shardSuffix()})`,
  () => {
    if (cases.length === 0) test.skip("no program falls in this shard", () => {});
    for (const c of cases) {
      describe(c.name, () => {
        test("default", async (context) => {
          const { failure, native } = await defaultFailure(c);
          if (native) {
            // The native tier's difference: the npm suite and the corpus
            // pin it. An entry left from when an island caused it is stale.
            if (!update && known[c.name]?.["default"] !== undefined)
              expect.fail(
                `${c.name} (default) no longer runs a package in an island: remove its entry from known-failures.json`,
              );
            record(c.name, "default", null);
            context.skip(`native difference (${failure!.category}): ${failure!.signature}`);
            return;
          }
          check(c.name, "default", failure);
        }, 900_000);
        for (const name of c.packages) {
          test(`island:${name}`, async (context) => {
            const { failure, skipped } = await islandFailure(c, name);
            // The automatic policy islands it: the default way covers it.
            if (skipped) {
              if (!update && known[c.name]?.[`island:${name}`] !== undefined)
                expect.fail(
                  `${c.name} runs ${name} in an island by default now: move its island:${name} entry to default`,
                );
              record(c.name, `island:${name}`, null);
              context.skip();
              return;
            }
            check(c.name, `island:${name}`, failure);
          }, 900_000);
        }
      });
    }

    afterAll(() => {
      if (!update) return;
      // Replace the entries of the ways this run observed, in the list as
      // it is now: a shard leaves the other shards' programs as they are
      // (shards may run side by side), and a way whose test did not finish
      // keeps its entry.
      const next = JSON.parse(readFileSync(knownPath, "utf8")) as Known;
      for (const [program, ways] of observed) {
        const entries: Record<string, Failure> = { ...next[program] };
        for (const [way, failure] of ways) {
          const unstable = entries[way]?.unstable === true;
          if (failure === null) {
            if (!unstable) delete entries[way];
          } else if (!unstable || entries[way]!.category !== failure.category)
            entries[way] = failure;
        }
        const sortedWays: Record<string, Failure> = {};
        for (const way of Object.keys(entries).sort()) sortedWays[way] = entries[way]!;
        if (Object.keys(sortedWays).length === 0) delete next[program];
        else next[program] = sortedWays;
      }
      const sorted: Known = {};
      for (const program of Object.keys(next).sort()) sorted[program] = next[program]!;
      writeFileSync(knownPath, `${JSON.stringify(sorted, null, 2)}\n`);
    });
  },
);
