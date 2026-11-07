// A build decides its Node islands in rounds: it lowers the program, islands
// what refused, loads and lowers again. With --node-island-decision the state
// its last round started from is kept in a file, and the next build's first
// round starts there (node-islands/decision-file.ts).
//
// These compile real island fixtures twice through prepareExecutableBuild,
// once deciding from scratch and once from the recorded file, and require the
// replayed build to be the recording build's last round and nothing else: one
// round, the same IR, the same warnings and island list, or the same failure.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  prepareExecutableBuild,
  type PreparedExecutableModule,
} from "../src/executable/prepare.js";
import type { CompileFailure } from "../src/compile-types.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";
import { serializeModule } from "../src/ir/serialize.js";

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
  /** Island rounds: each starts with one load of the program without
   * islands. */
  rounds: number;
  ok: boolean;
  /** The IR, warnings and island list of a compiling build, or the
   * diagnostics of a failing one, with the fixture directory replaced. */
  result: string;
}

function build(dir: string, decision: string | null): Built {
  let rounds = 0;
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages === undefined && options?.islandModules === undefined) rounds++;
    return runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
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
  format: number;
  retryFences: boolean;
  packages: { name: string; dir: string; version: string | null; class: string; reason: string }[];
  modules: unknown[];
}

function recorded(file: string): Recorded {
  return JSON.parse(readFileSync(file, "utf8")) as Recorded;
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
  // A replay that decides the same leaves the file as it is.
  expect(readFileSync(file, "utf8")).toBe(text);
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
  expect(file.packages.map((p) => [p.name, p.dir])).toEqual([
    ["schemakit", "node_modules/schemakit"],
  ]);
  // The recorded round ran after the fence report, which runs once.
  expect(file.retryFences).toBe(false);
}, 600_000);

test("a lowering refusal's island is replayed in one round", () => {
  // The package's own class refuses to lower (it extends Promise).
  const r = recordAndReplay("tests/corpus/8809-node-island-asserted-receivers");
  expect(r.scratchBuild.rounds).toBe(2);
  expect(r.replay.rounds).toBe(1);
  expect(r.replay.result).toBe(r.scratchBuild.result);
  expect(recorded(r.file).packages.map((p) => p.name)).toEqual(["sdk-pkg"]);
  // The lowering's own retry leaves the fence rules on.
  expect(recorded(r.file).retryFences).toBe(true);
}, 600_000);

test("a compiling build's sure-fence island is replayed without the native build", () => {
  // The native build compiles; a fence that surely fires asks for one more
  // build with the package as an island, and that build is kept.
  const r = recordAndReplay("tests/corpus/6817-node-island-esm");
  expect(r.scratchBuild.rounds).toBe(2);
  expect(r.replay.rounds).toBe(1);
  expect(r.replay.result).toBe(r.scratchBuild.result);
  expect(recorded(r.file).packages.map((p) => p.name)).toEqual(["esmisland"]);
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
  const parsed = recorded(file);
  writeFileSync(file, `${JSON.stringify({ ...parsed, packages: [] }, null, 2)}\n`);
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
  writeFileSync(
    file,
    `${JSON.stringify(
      { ...parsed, packages: parsed.packages.map((p) => ({ ...p, version: "0.0.0-older" })) },
      null,
      2,
    )}\n`,
  );
  const again = build(dir, file);
  expect(again.rounds).toBe(2);
  expect(again.result).toBe(scratchBuild.result);
  expect(recorded(file).packages.map((p) => p.version)).toEqual(
    parsed.packages.map((p) => p.version),
  );
}, 600_000);
