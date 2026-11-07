// A build decides its Node islands in rounds: it lowers the program, islands
// what refused, loads and lowers again. With --node-island-decision the
// islands its last round started from are kept in a file, and the next
// build's first round starts there (node-islands/decision-file.ts).
//
// These compile real island fixtures twice through prepareExecutableBuild,
// once deciding from scratch and once from the recorded file, and require the
// replayed build to be the recording build's last round and nothing else: one
// round, the same IR, the same warnings and island list, or the same failure.
// A program that changed since the record must end where a build from
// scratch ends, with the file such a build writes: a dependency it no longer
// imports leaves the set, and the islands a fence rule added for a failing
// build are decided again once the program compiles (and the other way
// round). checkIslandDecision is the oracle throughout: it decides from
// scratch and reports any difference from the file.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  checkIslandDecision,
  prepareExecutableBuild,
  type PreparedExecutableModule,
} from "../src/executable/prepare.js";
import type { CompileFailure } from "../src/compile-types.js";
import { analyzeWithFrontend } from "../src/frontend/analysis.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { serializeModule } from "../src/ir/serialize.js";
import { islandDecisionKey, writeIslandDecision } from "../src/node-islands/decision-file.js";
import { nodeIslandPolicy } from "../src/node-islands/policy.js";
import { emptyProjectConfig } from "../src/project-config.js";

const repoRoot = join(import.meta.dirname, "../../..");
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A private copy of a fixture directory (its main.ts and node_modules). */
function fixture(relative: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-decision-"));
  scratch.push(dir);
  cpSync(join(repoRoot, relative), dir, { recursive: true });
  return dir;
}

interface Built {
  /** Island rounds that reached their lowering: each lowers the program
   * once. (The rounds of one build share the load of the program without
   * islands, so loads do not count them.) */
  rounds: number;
  ok: boolean;
  /** The IR, warnings and island list of a compiling build, or the
   * diagnostics of a failing one, with the fixture directory replaced. */
  result: string;
}

/** What a build from scratch decides, against the file: no line when a
 * build would leave the file as it is. */
function check(dir: string, decision: string): string[] {
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) =>
    runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
  const checked = checkIslandDecision(
    join(dir, "main.ts"),
    { outPath: join(dir, "main"), outDir: dir, nodeIslands: { decision } },
    null,
    process.platform,
    factory,
    () => {},
  );
  expect(checked.file).toBe(decision);
  expect(checked.undecided).toBeNull();
  return checked.differences;
}

function build(dir: string, decision: string | null): Built {
  let rounds = 0;
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    const fe = runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
    return {
      ...fe,
      lower: (...args: Parameters<typeof fe.lower>) => {
        rounds++;
        return fe.lower(...args);
      },
    };
  };
  const prepared: PreparedExecutableModule | CompileFailure = prepareExecutableBuild(
    join(dir, "main.ts"),
    {
      outPath: join(dir, "main"),
      outDir: dir,
      ...(decision === null ? {} : { nodeIslands: { decision } }),
    },
    null,
    process.platform,
    factory,
    () => {},
    null,
  );
  const text = prepared.ok
    ? JSON.stringify({
        ir: serializeModule(prepared.mod),
        warnings: prepared.warnings,
        islands: prepared.islands ?? null,
      })
    : JSON.stringify(prepared.diagnostics);
  return {
    rounds,
    ok: prepared.ok,
    result: text.split(dir).join("<dir>"),
  };
}

interface Recorded {
  entry: string;
  compiler: string;
  outcome?: string;
  packages: {
    name: string;
    dir: string;
    version: string | null;
    rule?: string;
    follows?: string;
    class: string;
    reason: string;
  }[];
  modules: unknown[];
}

/** The file's one section (these builds use one entry and one set of
 * options). */
function recorded(file: string): Recorded {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    format: number;
    decisions: Recorded[];
  };
  expect(parsed.format).toBe(2);
  expect(parsed.decisions).toHaveLength(1);
  return parsed.decisions[0]!;
}

/** Writes the file with its one section changed. */
function rewrite(file: string, change: (section: Recorded) => Recorded): void {
  writeFileSync(
    file,
    `${JSON.stringify({ format: 2, decisions: [change(recorded(file))] }, null, 2)}\n`,
  );
}

/** Builds a fixture from scratch, records it, and replays the record. */
function recordAndReplay(relative: string): {
  scratchBuild: Built;
  recording: Built;
  replay: Built;
  file: string;
  dir: string;
} {
  const dir = fixture(relative);
  const file = join(dir, "islands.json");
  const scratchBuild = build(dir, null);
  expect(existsSync(file)).toBe(false);
  const recording = build(dir, file);
  const text = readFileSync(file, "utf8");
  const replay = build(dir, file);
  // A replay that decides the same leaves the file as it is, and the file is
  // what a build from scratch decides.
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(check(dir, file)).toEqual([]);
  return { scratchBuild, recording, replay, file, dir };
}

test("a failing build's fence-report island is replayed in one round", () => {
  // The program fails natively, so the package with an object-model marker
  // is tried as an island (the fence-report retry), and that build compiles.
  const r = recordAndReplay("tests/corpus/6829-node-island-declared-types");
  expect(r.scratchBuild.rounds).toBe(2);
  expect(r.recording.rounds).toBe(2);
  expect(r.recording.result).toBe(r.scratchBuild.result);
  expect(r.replay.rounds).toBe(1);
  expect(r.replay.ok).toBe(true);
  expect(r.replay.result).toBe(r.scratchBuild.result);
  const file = recorded(r.file);
  expect(file.packages.map((p) => [p.name, p.dir, p.rule])).toEqual([
    ["schemakit", "node_modules/schemakit", "fence-report"],
  ]);
  // The island is what makes the program compile: the outcome it was
  // recorded under is the one every replay ends with.
  expect(file.outcome).toBe("compiles");
}, 600_000);

test("a lowering refusal's island is replayed in one round", () => {
  // The package's own class refuses to lower (it extends Promise).
  const r = recordAndReplay("tests/corpus/8809-node-island-asserted-receivers");
  expect(r.scratchBuild.rounds).toBe(2);
  expect(r.replay.rounds).toBe(1);
  expect(r.replay.result).toBe(r.scratchBuild.result);
  expect(recorded(r.file).packages.map((p) => [p.name, p.rule])).toEqual([["sdk-pkg", "lowering"]]);
  // No island here depends on how the build ends.
  expect(recorded(r.file).outcome).toBeUndefined();
}, 600_000);

test("a compiling build's sure-fence island is replayed without the native build", () => {
  // The native build compiles; a fence that surely fires asks for one more
  // build with the package as an island, and that build is kept.
  const r = recordAndReplay("tests/corpus/6817-node-island-esm");
  expect(r.scratchBuild.rounds).toBe(2);
  expect(r.replay.rounds).toBe(1);
  expect(r.replay.result).toBe(r.scratchBuild.result);
  expect(recorded(r.file).packages.map((p) => [p.name, p.rule])).toEqual([
    ["esmisland", "fence-sure"],
  ]);
  expect(recorded(r.file).outcome).toBe("compiles");
}, 600_000);

test("a dependency added after the record gets the island a build from scratch gives it", () => {
  // The record holds one sure-fence island, decided by a fence attempt.
  const dir = fixture("tests/corpus/6817-node-island-esm");
  const file = join(dir, "islands.json");
  build(dir, file);
  expect(recorded(file).packages.map((p) => p.name)).toEqual(["esmisland"]);
  // The program then imports a second package of the same kind: it compiles
  // natively with a fence that surely fires, which only a fence rule sees.
  cpSync(
    join(repoRoot, "tests/corpus/6826-node-island-undefined-args/node_modules/argprobe"),
    join(dir, "node_modules/argprobe"),
    { recursive: true },
  );
  const main = join(dir, "main.ts");
  writeFileSync(
    main,
    `${readFileSync(main, "utf8")}
import { probe as addedProbe } from "argprobe";
console.log(addedProbe());
`,
  );
  const scratchBuild = build(dir, null);
  expect(scratchBuild.ok).toBe(true);
  const replay = build(dir, file);
  expect(replay.result).toBe(scratchBuild.result);
  expect(recorded(file).packages.map((p) => p.name)).toEqual(["argprobe", "esmisland"]);
  expect(check(dir, file)).toEqual([]);
  // And from then on one round.
  const settled = build(dir, file);
  expect(settled.rounds).toBe(1);
  expect(settled.result).toBe(scratchBuild.result);
}, 600_000);

test("a failing build records its decision, and the replay reports the same failure", () => {
  const dir = fixture("tests/corpus/8809-node-island-asserted-receivers");
  // An error of the program's own that no island removes.
  const main = join(dir, "main.ts");
  writeFileSync(
    main,
    `${readFileSync(main, "utf8")}
const refusedName = "na" + "me";
class Refused {
  [refusedName]() {
    return 1;
  }
}
console.log(new Refused());
`,
  );
  const file = join(dir, "islands.json");
  const scratchBuild = build(dir, null);
  expect(scratchBuild.ok).toBe(false);
  expect(scratchBuild.rounds).toBeGreaterThanOrEqual(2);
  const recording = build(dir, file);
  expect(recording.result).toBe(scratchBuild.result);
  expect(recorded(file).packages.map((p) => p.name)).toEqual(["sdk-pkg"]);
  const replay = build(dir, file);
  expect(replay.ok).toBe(false);
  expect(replay.rounds).toBe(1);
  expect(replay.result).toBe(scratchBuild.result);
  expect(check(dir, file)).toEqual([]);
}, 600_000);

/** An error of the program's own that no island removes. */
const OWN_ERROR = `
const refusedName = "na" + "me";
class Refused {
  [refusedName]() {
    return 1;
  }
}
console.log(new Refused());
`;

/** A program that imports a package with a constructor function and a
 * prototype method. The package compiles natively, and its object model is
 * a reason to run it in Node that only a failing build acts on (the fence
 * report). */
function counterProgram(own: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-decision-"));
  scratch.push(dir);
  const pkg = join(dir, "node_modules", "counter");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    '{ "name": "counter", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n',
  );
  writeFileSync(
    join(pkg, "index.js"),
    `"use strict";
function Counter(start) {
  this.n = start;
}
Counter.prototype.next = function () {
  this.n = this.n + 1;
  return this.n;
};
exports.make = function (start) {
  return new Counter(start);
};
`,
  );
  writeFileSync(
    join(pkg, "index.d.ts"),
    `export interface Counter {
  next(): number;
}
export declare function make(start: number): Counter;
`,
  );
  writeFileSync(join(dir, "main.ts"), counterMain(own));
  return dir;
}

function counterMain(own: string): string {
  return `import { make } from "counter";
const c = make(40);
c.next();
console.log(c.next());
${own}`;
}

test("the islands a failing build got from the fence report are decided again when it compiles", () => {
  const dir = counterProgram(OWN_ERROR);
  const file = join(dir, "islands.json");
  // While the program fails, the package runs in Node: two rounds from
  // scratch, one from the record, the same failure.
  const failing = build(dir, null);
  expect(failing.ok).toBe(false);
  expect(failing.rounds).toBe(2);
  expect(build(dir, file).result).toBe(failing.result);
  expect(recorded(file).packages.map((p) => [p.name, p.rule])).toEqual([
    ["counter", "fence-report"],
  ]);
  expect(recorded(file).outcome).toBe("fails");
  const replayed = build(dir, file);
  expect(replayed.rounds).toBe(1);
  expect(replayed.result).toBe(failing.result);
  expect(check(dir, file)).toEqual([]);

  // The program's error is fixed. A build from scratch compiles the package
  // natively; the record's island was decided for a program that failed.
  writeFileSync(join(dir, "main.ts"), counterMain(""));
  const compiling = build(dir, null);
  expect(compiling.ok).toBe(true);
  expect(compiling.rounds).toBe(1);
  expect(compiling.result).toContain('"islands":null');
  // The check sees it before any build does.
  expect(check(dir, file)).toEqual(["~ outcome: fails -> none", "- counter@1.0.0"]);
  // The replay compiles with the island, so the island is decided again:
  // one more round, and the result and the file are the build from
  // scratch's.
  const flipped = build(dir, file);
  expect(flipped.rounds).toBe(2);
  expect(flipped.result).toBe(compiling.result);
  expect(recorded(file).packages).toEqual([]);
  expect(recorded(file).outcome).toBeUndefined();
  expect(check(dir, file)).toEqual([]);
  // And from then on one round.
  const settled = build(dir, file);
  expect(settled.rounds).toBe(1);
  expect(settled.result).toBe(compiling.result);

  // The error comes back: the record holds nothing that depends on the
  // outcome, and the failing program gets its island by a round, as from
  // scratch.
  writeFileSync(join(dir, "main.ts"), counterMain(OWN_ERROR));
  const again = build(dir, file);
  expect(again.rounds).toBe(2);
  expect(again.result).toBe(failing.result);
  expect(recorded(file).outcome).toBe("fails");
  expect(check(dir, file)).toEqual([]);
}, 600_000);

test("a sure-fence island is decided again when the program stops compiling", () => {
  const dir = fixture("tests/corpus/6817-node-island-esm");
  const file = join(dir, "islands.json");
  build(dir, file);
  expect(recorded(file).packages.map((p) => [p.name, p.rule])).toEqual([
    ["esmisland", "fence-sure"],
  ]);
  const main = join(dir, "main.ts");
  const source = readFileSync(main, "utf8");
  writeFileSync(main, source + OWN_ERROR);
  // From scratch the failing program lowers natively first, and its fence
  // report decides the islands; the replay must end there too, not with the
  // islands a compiling build asked for.
  const scratchBuild = build(dir, null);
  expect(scratchBuild.ok).toBe(false);
  const replay = build(dir, file);
  expect(replay.result).toBe(scratchBuild.result);
  expect(check(dir, file)).toEqual([]);
  expect(recorded(file).packages.every((p) => p.rule !== "fence-sure")).toBe(true);
  // Fixed again: back to the compiling build's decision.
  writeFileSync(main, source);
  const compiling = build(dir, null);
  const back = build(dir, file);
  expect(back.result).toBe(compiling.result);
  expect(recorded(file).packages.map((p) => [p.name, p.rule])).toEqual([
    ["esmisland", "fence-sure"],
  ]);
  expect(check(dir, file)).toEqual([]);
  expect(build(dir, file).rounds).toBe(1);
}, 600_000);

test("a recorded package the program no longer imports leaves the set", () => {
  const dir = fixture("tests/corpus/8809-node-island-asserted-receivers");
  const file = join(dir, "islands.json");
  build(dir, file);
  expect(recorded(file).packages.map((p) => p.name)).toEqual(["sdk-pkg"]);
  // The program drops the dependency. The package is still installed, at
  // the recorded version.
  writeFileSync(join(dir, "main.ts"), 'console.log(["no", "sdk"].join(" "));\n');
  const scratchBuild = build(dir, null);
  expect(scratchBuild.ok).toBe(true);
  expect(scratchBuild.result).toContain('"islands":null');
  expect(check(dir, file)).toEqual(["- sdk-pkg@1.0.0"]);
  const replay = build(dir, file);
  // One lowering: the first load shows the import is gone before any round
  // lowers with the island.
  expect(replay.rounds).toBe(1);
  expect(replay.result).toBe(scratchBuild.result);
  expect(recorded(file).packages).toEqual([]);
  expect(check(dir, file)).toEqual([]);
}, 600_000);

test("an island the load decides is listed in the file and decided from the load again", () => {
  // A package the project marks to run in Node: the first decision islands
  // it from the load in every build, replayed or not, and no rule grows it.
  const dir = counterProgram("");
  writeFileSync(
    join(dir, "package.json"),
    '{ "name": "app", "scriptc": { "packages": { "counter": "node" } } }\n',
  );
  const file = join(dir, "islands.json");
  const scratchBuild = build(dir, null);
  expect(scratchBuild.ok).toBe(true);
  expect(scratchBuild.rounds).toBe(1);
  expect(scratchBuild.result).toContain('"packages":["counter"]');
  const recording = build(dir, file);
  expect(recording.result).toBe(scratchBuild.result);
  // The file names every island of the program, with `load` for one no
  // rule had to grow.
  expect(recorded(file).packages.map((p) => [p.name, p.rule])).toEqual([["counter", "load"]]);
  expect(recorded(file).outcome).toBeUndefined();
  const text = readFileSync(file, "utf8");
  const replay = build(dir, file);
  expect(replay.rounds).toBe(1);
  expect(replay.result).toBe(scratchBuild.result);
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(check(dir, file)).toEqual([]);
  // The mark goes: the next build's load no longer decides the island, the
  // check says so, and the file follows the build.
  writeFileSync(join(dir, "package.json"), '{ "name": "app" }\n');
  expect(check(dir, file)).toEqual(["- counter@1.0.0"]);
  const unmarked = build(dir, file);
  expect(unmarked.result).toContain('"islands":null');
  expect(recorded(file).packages).toEqual([]);
  expect(check(dir, file)).toEqual([]);
}, 600_000);

test("a build that stops before its lowering leaves the record as it is", () => {
  const dir = fixture("tests/corpus/8809-node-island-asserted-receivers");
  const file = join(dir, "islands.json");
  build(dir, file);
  const text = readFileSync(file, "utf8");
  // A type error: the program never reaches its lowering.
  const main = join(dir, "main.ts");
  const source = readFileSync(main, "utf8");
  writeFileSync(main, `${source}\nconst wrong: number = "text";\nconsole.log(wrong);\n`);
  const failing = build(dir, file);
  expect(failing.ok).toBe(false);
  expect(failing.rounds).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(text);
  // Fixed: one round from the record, as before.
  writeFileSync(main, source);
  expect(build(dir, file).rounds).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(text);
}, 600_000);

test("a program without islands records an empty decision and builds as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-decision-"));
  scratch.push(dir);
  writeFileSync(join(dir, "main.ts"), 'console.log([1, 2, 3].map((n) => n * 2).join(","));\n');
  const file = join(dir, "islands.json");
  const scratchBuild = build(dir, null);
  const recording = build(dir, file);
  const replay = build(dir, file);
  expect([scratchBuild.rounds, recording.rounds, replay.rounds]).toEqual([1, 1, 1]);
  expect(recording.result).toBe(scratchBuild.result);
  expect(replay.result).toBe(scratchBuild.result);
  expect(recorded(file).packages).toEqual([]);
  expect(recorded(file).modules).toEqual([]);
}, 600_000);

test("a record that misses an island is grown by a round and written back", () => {
  const dir = fixture("tests/corpus/8809-node-island-asserted-receivers");
  const file = join(dir, "islands.json");
  const scratchBuild = build(dir, null);
  build(dir, file);
  const full = readFileSync(file, "utf8");
  // The same record without its package: what an older build of a program
  // that did not import the package yet would have left.
  rewrite(file, (section) => ({ ...section, packages: [] }));
  const grown = build(dir, file);
  expect(grown.rounds).toBe(2);
  expect(grown.result).toBe(scratchBuild.result);
  expect(readFileSync(file, "utf8")).toBe(full);
}, 600_000);

test("a recorded package whose version changed is decided again", () => {
  const dir = fixture("tests/corpus/8809-node-island-asserted-receivers");
  const file = join(dir, "islands.json");
  const scratchBuild = build(dir, null);
  build(dir, file);
  const parsed = recorded(file);
  rewrite(file, (section) => ({
    ...section,
    packages: section.packages.map((p) => ({ ...p, version: "0.0.0-older" })),
  }));
  const again = build(dir, file);
  expect(again.rounds).toBe(2);
  expect(again.result).toBe(scratchBuild.result);
  expect(recorded(file).packages.map((p) => p.version)).toEqual(
    parsed.packages.map((p) => p.version),
  );
}, 600_000);

/** A coverage analysis of the fixture, with the lowerings it took. */
function analyze(dir: string, decision: string | null, entry = "main.ts") {
  let lowerings = 0;
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    const fe = runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
    return {
      ...fe,
      lower: (...args: Parameters<typeof fe.lower>) => {
        lowerings++;
        return fe.lower(...args);
      },
    };
  };
  const { coverage } = analyzeWithFrontend(
    join(dir, entry),
    decision === null ? {} : { nodeIslands: { decision } },
    process.platform,
    factory,
  );
  return {
    lowerings,
    stats: coverage.stats,
    diagnostics: JSON.stringify(coverage.diagnostics).split(dir).join("<dir>"),
    islands: (coverage.nodeIslands?.islands ?? []).map((i) => [i.package, i.class, i.reason]),
  };
}

test("an analysis lowers with the recorded islands and reports the program a build compiles", () => {
  const dir = fixture("tests/corpus/8809-node-island-asserted-receivers");
  const file = join(dir, "islands.json");
  // From scratch the analysis finds the package's refusal by lowering it
  // natively, then lowers again with the package in Node.
  const scratchAnalysis = analyze(dir, null);
  expect(scratchAnalysis.lowerings).toBe(2);
  expect(scratchAnalysis.islands.map((i) => i[0])).toEqual(["sdk-pkg"]);
  // A file that records nothing changes nothing, and an analysis never
  // writes one.
  expect(analyze(dir, file)).toEqual(scratchAnalysis);
  expect(existsSync(file)).toBe(false);

  build(dir, file);
  const text = readFileSync(file, "utf8");
  const island = recorded(file).packages[0]!;
  const replayed = analyze(dir, file);
  expect(replayed.lowerings).toBe(1);
  expect(replayed.stats).toEqual(scratchAnalysis.stats);
  expect(replayed.diagnostics).toBe(scratchAnalysis.diagnostics);
  // The report names the island with the class and reason the build
  // recorded for it.
  expect(replayed.islands).toEqual([["sdk-pkg", island.class, island.reason]]);
  expect(readFileSync(file, "utf8")).toBe(text);

  // The program drops the dependency: the analysis asks its load, as a
  // build does, and lowers the program without the island.
  writeFileSync(join(dir, "main.ts"), 'console.log(["no", "sdk"].join(" "));\n');
  const dropped = analyze(dir, file);
  expect(dropped).toEqual(analyze(dir, null));
  expect(dropped.islands).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe(text);
}, 600_000);

test("an analysis decides a failing build's fence-report islands again when the program compiles", () => {
  const dir = counterProgram(OWN_ERROR);
  const file = join(dir, "islands.json");
  build(dir, file);
  expect(recorded(file).packages.map((p) => [p.name, p.rule])).toEqual([
    ["counter", "fence-report"],
  ]);
  writeFileSync(join(dir, "main.ts"), counterMain(""));
  // The record's island was decided for a program that failed; this one
  // compiles, so the analysis lowers it as a build from scratch does: with
  // the package compiled natively.
  const from = analyze(dir, null);
  const replayed = analyze(dir, file);
  expect(replayed.stats).toEqual(from.stats);
  expect(replayed.diagnostics).toBe(from.diagnostics);
  expect(replayed.islands).toEqual(from.islands);
}, 600_000);

/** A build of `entry` in `dir` that keeps its decision in `file`. */
function buildEntry(dir: string, entry: string, file: string): boolean {
  const factory: FrontendFactory = (path, npmStatic, externalTypes, libraryNpmStatic, options) =>
    runFrontend(path, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
  return prepareExecutableBuild(
    join(dir, entry),
    { outPath: join(dir, "main"), outDir: dir, nodeIslands: { decision: file } },
    null,
    process.platform,
    factory,
    () => {},
    null,
  ).ok;
}

function recordedModules(file: string): { file: string; rule: string }[] {
  return (
    JSON.parse(readFileSync(file, "utf8")) as {
      decisions: { modules: { file: string; rule: string }[] }[];
    }
  ).decisions[0]!.modules;
}

test("an analysis of a program whose island module fails the type check stops there, record or not", () => {
  // A sloppy CommonJS module with a `with` statement. A build checks the
  // program it reloads without the module; this analysis checks its first
  // load, which still holds the module, and stops at the checker's error
  // before it lowers anything, so the record, which takes effect when the
  // analysis lowers, changes nothing here.
  const dir = fixture("tests/corpus/8427-sloppy-with-island");
  const file = join(dir, "islands.json");
  const from = analyze(dir, null, "main.js");
  expect(from.diagnostics).toContain("<dir>/lookup.js");
  expect(buildEntry(dir, "main.js", file)).toBe(true);
  expect(recordedModules(file)).toMatchObject([{ file: "lookup.js", rule: "load" }]);
  expect(analyze(dir, file, "main.js")).toEqual(from);
}, 600_000);

test("an analysis lowers a recorded user-module island out of the program, as a build does", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-decision-"));
  scratch.push(dir);
  // A user module a native build refuses at run time (SC2020), recorded as a
  // module island: the build that replays the record runs it in Node.
  const legacy = join(dir, "legacy.js").split("\\").join("/");
  writeFileSync(
    legacy,
    '"use strict";\nexports.bump = function () { var r = new WeakRef({}); return typeof r.deref(); };\n',
  );
  writeFileSync(join(dir, "legacy.d.ts"), "export declare function bump(): unknown;\n");
  writeFileSync(
    join(dir, "main.ts"),
    'import { bump } from "./legacy.js";\nconsole.log(bump());\n',
  );
  const file = join(dir, "islands.json");
  writeIslandDecision(
    file,
    islandDecisionKey(join(dir, "main.ts"), undefined, undefined, undefined, process.platform),
    nodeIslandPolicy(emptyProjectConfig()),
    {
      packages: new Map(),
      modules: new Map([
        [legacy, { file: legacy, class: "object-model", reason: "recorded", decision: "auto" }],
      ]),
    },
    "compiles",
  );
  expect(build(dir, file).result).toContain('"modules":["<dir>/legacy.js"]');
  const coverage = (decision: string | null) =>
    analyzeWithFrontend(
      join(dir, "main.ts"),
      decision === null ? {} : { nodeIslands: { decision } },
      process.platform,
      (entry, npmStatic, externalTypes, libraryNpmStatic, options) =>
        runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options),
    ).coverage;
  const fenced = (c: ReturnType<typeof coverage>) =>
    (c.runtimeFences ?? []).map((d) => [d.code, d.loc.file.split(dir).join("<dir>")]);
  // From scratch the module is native and its fence is a blocker.
  expect(fenced(coverage(null))).toEqual([["SC2020", "<dir>/legacy.js"]]);
  // With the record, the analysis lowers the program the build compiles: the
  // module runs in Node, and only the entry's statements are counted.
  const replayed = coverage(file);
  expect(fenced(replayed)).toEqual([]);
  expect(replayed.stats.statementsFailed).toBe(0);
  expect(replayed.stats.statementsTotal).toBeLessThan(coverage(null).stats.statementsTotal);
}, 600_000);
