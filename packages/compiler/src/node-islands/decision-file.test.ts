import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { emptyProjectConfig, parseProjectConfig } from "../project-config.js";
import type { IslandModule, IslandPackage, IslandRule } from "./boundary.js";
import {
  admitRecorded,
  compareIslandDecision,
  describeIslandDecisionChange,
  islandDecisionDigest,
  islandDecisionKey,
  readIslandDecision,
  staleByOutcome,
  withRecordedDecision,
  writeIslandDecision,
  type IslandDecisionKey,
  type IslandRoundState,
} from "./decision-file.js";
import { nodeIslandOptionsKey, nodeIslandPolicy, type NodeIslandOptions } from "./policy.js";
import type { NodeIslandScan, PackageEdge } from "./scan.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Project {
  dir: string;
  entry: string;
  file: string;
  install: (name: string, version: string, rule?: IslandRule, follows?: string) => IslandPackage;
  legacy: IslandModule;
}

/** A project directory with an entry, one user JavaScript module, and a way
 * to install packages. */
function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-decision-"));
  scratch.push(dir);
  const install = (
    name: string,
    version: string,
    rule: IslandRule = "lowering",
    follows?: string,
  ): IslandPackage => {
    const at = join(dir, "node_modules", name);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name, version }));
    return {
      name,
      version,
      dir: at.split("\\").join("/"),
      class: "gap",
      reason: `SC1090: ${name} refused`,
      rule,
      ...(follows === undefined ? {} : { follows }),
    };
  };
  mkdirSync(join(dir, "src"), { recursive: true });
  const entry = join(dir, "src", "main.ts");
  writeFileSync(entry, "export {};\n");
  const legacyFile = join(dir, "src", "legacy.js").split("\\").join("/");
  writeFileSync(legacyFile, "with ({}) {}\n");
  return {
    dir,
    entry,
    file: join(dir, "scriptc-islands.json"),
    install,
    legacy: {
      file: legacyFile,
      class: "object-model",
      reason: "R2.4 sloppy-mode semantics: a 'with' statement",
      decision: "auto",
    },
  };
}

function state(packages: IslandPackage[], modules: IslandModule[] = []): IslandRoundState {
  return {
    packages: new Map(packages.map((p) => [p.name, p])),
    modules: new Map(modules.map((m) => [m.file, m])),
  };
}

function keyOf(
  p: Project,
  options?: NodeIslandOptions,
  npmStatic?: string[] | string,
  platform = "linux",
): IslandDecisionKey {
  return islandDecisionKey(p.entry, options, npmStatic, undefined, platform);
}

const auto = nodeIslandPolicy(emptyProjectConfig());

interface FileJson {
  format: number;
  decisions: {
    entry: string;
    target: string;
    options?: Record<string, unknown>;
    compiler: string;
    outcome?: string;
    packages: Record<string, unknown>[];
    modules: Record<string, unknown>[];
  }[];
}

function fileJson(file: string): FileJson {
  return JSON.parse(readFileSync(file, "utf8")) as FileJson;
}

/** A scan with one user import of each named package. */
function scanOf(p: Project, imports: IslandPackage[], files: string[] = []): NodeIslandScan {
  const edges: PackageEdge[] = imports.map((island) => ({
    fromDir: null,
    fromFile: p.entry,
    to: island.name,
    toDir: island.dir,
    shim: false,
    loads: true,
    loc: { file: p.entry, start: 0, end: 0 },
  }));
  return {
    modules: [p.entry, ...files].map((file) => ({
      file,
      origin: "user" as const,
      packageDir: null,
      packageName: null,
      markers: [],
      cjsReads: [],
      globalReads: [],
      stripProblem: null,
      dropped: false,
    })),
    edges,
    refusals: [],
  };
}

test("a decision is written with paths relative to the file and read back", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const cfg = p.install("@scope/cfg", "0.1.0", "preflight");
  const key = keyOf(p);
  const change = writeIslandDecision(p.file, key, auto, state([sdk, cfg], [p.legacy]), "compiles");
  expect(change?.first).toBe(true);
  const json = fileJson(p.file);
  expect(json.format).toBe(2);
  expect(json.decisions).toHaveLength(1);
  const section = json.decisions[0]!;
  expect(section.entry).toBe("src/main.ts");
  expect(section.target).toBe("linux");
  expect(section.options).toBeUndefined();
  // No island here depends on how the build ended.
  expect(section.outcome).toBeUndefined();
  expect(section.packages).toEqual([
    {
      name: "@scope/cfg",
      version: "0.1.0",
      dir: "node_modules/@scope/cfg",
      rule: "preflight",
      class: "gap",
      reason: "SC1090: @scope/cfg refused",
    },
    {
      name: "sdk",
      version: "1.2.3",
      dir: "node_modules/sdk",
      rule: "lowering",
      class: "gap",
      reason: "SC1090: sdk refused",
    },
  ]);
  expect(section.modules).toEqual([
    {
      file: "src/legacy.js",
      rule: "lowering",
      class: "object-model",
      reason: "R2.4 sloppy-mode semantics: a 'with' statement",
      decision: "auto",
    },
  ]);
  const read = readIslandDecision(p.file, key, auto);
  expect(read).not.toBeNull();
  expect([...read!.packages.values()]).toEqual([cfg, sdk]);
  expect([...read!.modules.values()]).toEqual([p.legacy]);
  expect(read!.outcome).toBeNull();
  expect(read!.gone.size).toBe(0);
  // The same decision is the same bytes: nothing is written again.
  const text = readFileSync(p.file, "utf8");
  expect(writeIslandDecision(p.file, key, auto, state([cfg, sdk], [p.legacy]), "fails")).toBeNull();
  expect(readFileSync(p.file, "utf8")).toBe(text);
});

test("each entry, target and set of options has its own section", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const other = join(p.dir, "src", "other.ts");
  writeFileSync(other, "export {};\n");
  const linux = keyOf(p);
  const darwin = keyOf(p, undefined, undefined, "darwin");
  const withStatic = keyOf(p, { islands: ["zed", join(p.dir, "src", "plugin.js")] }, ["b", "a"]);
  const second = islandDecisionKey(other, undefined, undefined, undefined, "linux");
  writeIslandDecision(p.file, linux, auto, state([sdk]), "compiles");
  writeIslandDecision(p.file, darwin, auto, state([]), "compiles");
  writeIslandDecision(p.file, withStatic, auto, state([]), "compiles");
  writeIslandDecision(p.file, second, auto, state([]), "compiles");
  const json = fileJson(p.file);
  expect(json.decisions.map((d) => [d.entry, d.target, d.options ?? null])).toEqual([
    ["src/main.ts", "darwin", null],
    ["src/main.ts", "linux", null],
    // A module named by --node-island is recorded relative to the file, and
    // the npm-static request by its sorted names.
    ["src/main.ts", "linux", { nodeIsland: ["src/plugin.js", "zed"], npmStatic: ["a", "b"] }],
    ["src/other.ts", "linux", null],
  ]);
  expect(readIslandDecision(p.file, linux, auto)!.packages.size).toBe(1);
  expect(readIslandDecision(p.file, darwin, auto)!.packages.size).toBe(0);
  expect(readIslandDecision(p.file, second, auto)!.packages.size).toBe(0);
  expect(readIslandDecision(p.file, keyOf(p, undefined, "auto"), auto)).toBeNull();
  // Writing one section leaves the others byte for byte.
  const before = fileJson(p.file).decisions.filter((d) => d.target !== "linux" || d.options);
  writeIslandDecision(p.file, linux, auto, state([]), "compiles");
  const after = fileJson(p.file).decisions.filter((d) => d.target !== "linux" || d.options);
  expect(after).toEqual(before);
  expect(readIslandDecision(p.file, linux, auto)!.packages.size).toBe(0);
});

test("a section another compiler release recorded is not replayed, and is replaced", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const key = keyOf(p);
  writeIslandDecision(p.file, { ...key, compiler: "0.0.1-older" }, auto, state([sdk]), "compiles");
  expect(readIslandDecision(p.file, key, auto)).toBeNull();
  const change = writeIslandDecision(p.file, key, auto, state([sdk]), "compiles");
  expect(change?.first).toBe(false);
  expect(change?.lines).toEqual([`~ compiler: 0.0.1-older -> ${key.compiler}`]);
  expect(fileJson(p.file).decisions).toHaveLength(1);
  expect(readIslandDecision(p.file, key, auto)!.packages.size).toBe(1);
});

test("only the automatic policy replays and records", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const key = keyOf(p);
  const explicit = nodeIslandPolicy(emptyProjectConfig(), { mode: "explicit" });
  expect(writeIslandDecision(p.file, key, explicit, state([sdk]), "compiles")).toBeNull();
  expect(() => readFileSync(p.file)).toThrow();
  writeIslandDecision(p.file, key, auto, state([sdk]), "compiles");
  expect(readIslandDecision(p.file, key, explicit)).toBeNull();
});

test("an entry whose package changed leaves, with the islands that follow it", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const wrapper = p.install("wrapper", "2.0.0", "esm-importer", "sdk");
  const outer = p.install("outer", "3.0.0", "esm-importer", "wrapper");
  const cfg = p.install("cfg", "0.1.0");
  const gonePkg = p.install("gone", "1.0.0");
  const key = keyOf(p);
  writeIslandDecision(p.file, key, auto, state([sdk, wrapper, outer, cfg, gonePkg]), "compiles");
  // sdk is upgraded and gone is uninstalled.
  writeFileSync(
    join(p.dir, "node_modules", "sdk", "package.json"),
    JSON.stringify({ name: "sdk", version: "1.3.0" }),
  );
  rmSync(join(p.dir, "node_modules", "gone"), { recursive: true });
  const read = readIslandDecision(p.file, key, auto)!;
  expect([...read.packages.keys()]).toEqual(["cfg"]);
  expect([...read.gone]).toEqual([
    ["gone", "its directory is gone"],
    ["sdk", "its version changed from 1.2.3 to 1.3.0"],
    ["wrapper", "it is an island only with 'sdk'"],
    ["outer", "it is an island only with 'wrapper'"],
  ]);
  // The policy's own word about a recorded package wins over the record.
  const native = nodeIslandPolicy(emptyProjectConfig(), { native: ["cfg"] });
  const strict = readIslandDecision(p.file, keyOf(p, { native: ["cfg"] }), native);
  // (another --native list is another section: nothing recorded for it)
  expect(strict).toBeNull();
  const marked = nodeIslandPolicy(
    parseProjectConfig(
      join(p.dir, "package.json"),
      JSON.stringify({ scriptc: { packages: { cfg: "native" } } }),
    ),
  );
  const kept = readIslandDecision(p.file, key, marked)!;
  expect(kept.packages.size).toBe(0);
  expect(kept.gone.get("cfg")).toBe("the policy keeps it native");
});

test("a recorded island the program no longer imports is not admitted", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const wrapper = p.install("wrapper", "2.0.0", "esm-importer", "sdk");
  const cfg = p.install("cfg", "0.1.0");
  const recorded = state([sdk, wrapper, cfg], [p.legacy]);
  // Everything is still imported and loaded.
  const all = admitRecorded(recorded, scanOf(p, [sdk, wrapper, cfg], [p.legacy.file]), new Map());
  expect([...all.packages.keys()]).toEqual(["sdk", "wrapper", "cfg"]);
  expect([...all.modules.keys()]).toEqual([p.legacy.file]);
  // The program dropped its import of sdk and no longer loads the module:
  // sdk leaves, and so does the package that is an island only with it.
  const gone = new Map<string, string>();
  const some = admitRecorded(recorded, scanOf(p, [wrapper, cfg]), gone);
  expect([...some.packages.keys()]).toEqual(["cfg"]);
  expect(some.modules.size).toBe(0);
  expect([...gone]).toEqual([
    ["sdk", "the program no longer imports it"],
    ["wrapper", "it is an island only with 'sdk'"],
    [p.legacy.file, "the program no longer loads it"],
  ]);
  // An import that resolves to another copy of the package is not this one.
  const elsewhere = { ...cfg, dir: join(p.dir, "elsewhere", "cfg") };
  expect(admitRecorded(state([cfg]), scanOf(p, [elsewhere]), new Map()).packages.size).toBe(0);
  // A shim serves the import: nothing loads the package.
  const shimmed = scanOf(p, [cfg]);
  shimmed.edges[0]!.shim = true;
  expect(admitRecorded(state([cfg]), shimmed, new Map()).packages.size).toBe(0);
});

test("the islands a fence rule added for one outcome are stale under the other", () => {
  const p = project();
  const lowering = p.install("lowering", "1.0.0", "lowering");
  const report = p.install("report", "1.0.0", "fence-report");
  const sure = p.install("sure", "1.0.0", "fence-sure");
  const packages = state([lowering, report, sure]).packages;
  // The record's outcome stands: nothing is stale.
  expect(staleByOutcome("fails", packages, false).size).toBe(0);
  expect(staleByOutcome("compiles", packages, true).size).toBe(0);
  // A record without an outcome holds no island that depends on one.
  expect(staleByOutcome(null, packages, true).size).toBe(0);
  // A failing build's fence-report islands, once the program compiles.
  expect([...staleByOutcome("fails", packages, true).keys()]).toEqual(["report"]);
  // A compiling build's sure-fence islands, once the program fails. Its
  // fence-report islands are what made it compile: they stand.
  expect([...staleByOutcome("compiles", packages, false).keys()]).toEqual(["sure"]);
});

test("the outcome is recorded only while an island depends on it", () => {
  const p = project();
  const report = p.install("report", "1.0.0", "fence-report");
  const key = keyOf(p);
  writeIslandDecision(p.file, key, auto, state([report]), "fails");
  expect(fileJson(p.file).decisions[0]!.outcome).toBe("fails");
  expect(readIslandDecision(p.file, key, auto)!.outcome).toBe("fails");
  const change = writeIslandDecision(p.file, key, auto, state([report]), "compiles");
  expect(change?.lines).toEqual(["~ outcome: fails -> compiles"]);
  expect(readIslandDecision(p.file, key, auto)!.outcome).toBe("compiles");
});

test("a comparison names each kind of difference", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const cfg = p.install("cfg", "0.1.0", "fence-report");
  const key = keyOf(p);
  const decided = state([sdk, cfg], [p.legacy]);
  expect(compareIslandDecision(p.file, key, decided, "fails")).toEqual(["the file does not exist"]);
  writeIslandDecision(p.file, keyOf(p, undefined, "auto"), auto, decided, "fails");
  expect(compareIslandDecision(p.file, key, decided, "fails")).toEqual([
    "the file records no decision for this entry, target and options",
  ]);
  writeIslandDecision(p.file, key, auto, decided, "fails");
  expect(compareIslandDecision(p.file, key, decided, "fails")).toEqual([]);
  // An island the file lacks, and one a build from scratch does not have.
  const extra = p.install("extra", "9.9.9", "preflight");
  expect(compareIslandDecision(p.file, key, state([sdk, extra], [p.legacy]), "fails")).toEqual([
    // Without cfg no island depends on the outcome, so none is recorded.
    "~ outcome: fails -> none",
    "+ extra@9.9.9 (preflight): SC1090: extra refused",
    "- cfg@0.1.0",
  ]);
  // Another version, another rule, another reason.
  const changed: IslandPackage = {
    ...sdk,
    version: "1.3.0",
    rule: "preflight",
    reason: "SC1013: another reason",
  };
  expect(compareIslandDecision(p.file, key, state([changed, cfg], [p.legacy]), "fails")).toEqual([
    "~ sdk: version 1.2.3 -> 1.3.0, rule lowering -> preflight, reason: SC1013: another reason",
  ]);
  // The other outcome, and a module the file has that a build does not.
  expect(compareIslandDecision(p.file, key, state([sdk, cfg]), "compiles")).toEqual([
    "~ outcome: fails -> compiles",
    "- module src/legacy.js",
  ]);
  const plugin: IslandModule = { ...p.legacy, file: join(p.dir, "src", "plugin.js") };
  expect(
    compareIslandDecision(p.file, key, state([sdk, cfg], [p.legacy, plugin]), "fails"),
  ).toEqual(["+ module src/plugin.js (lowering): R2.4 sloppy-mode semantics: a 'with' statement"]);
  // Another compiler release.
  expect(compareIslandDecision(p.file, { ...key, compiler: "9.9.9" }, decided, "fails")).toEqual([
    `~ compiler: ${key.compiler} -> 9.9.9`,
  ]);
});

test("a build says what it changed in the file", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const cfg = p.install("cfg", "0.1.0");
  const key = keyOf(p);
  const first = writeIslandDecision(p.file, key, auto, state([sdk, cfg]), "compiles")!;
  expect(describeIslandDecisionChange(first, p.dir)).toBe(
    "scriptc: recorded the Node island decision in scriptc-islands.json (2 packages)\n" +
      "  + cfg@0.1.0 (lowering): SC1090: cfg refused\n" +
      "  + sdk@1.2.3 (lowering): SC1090: sdk refused\n",
  );
  const gone = new Map([["cfg", "the program no longer imports it"]]);
  const second = writeIslandDecision(p.file, key, auto, state([sdk]), "compiles", null, gone)!;
  expect(describeIslandDecisionChange(second, p.dir)).toBe(
    "scriptc: updated the Node island decision in scriptc-islands.json (1 package)\n" +
      "  - cfg@0.1.0: the program no longer imports it\n",
  );
  const none = writeIslandDecision(p.file, key, auto, state([]), "compiles")!;
  expect(describeIslandDecisionChange(none, p.dir)).toBe(
    "scriptc: updated the Node island decision in scriptc-islands.json (no islands)\n" +
      "  - sdk@1.2.3\n",
  );
});

test("a file this compiler does not read is replaced, never replayed", () => {
  const p = project();
  const sdk = p.install("sdk", "1.2.3");
  const key = keyOf(p);
  for (const text of [
    "not json",
    "[]",
    JSON.stringify({ format: 1, entry: "src/main.ts", policy: "", packages: [], modules: [] }),
    JSON.stringify({ format: 2, decisions: [{ entry: "src/main.ts" }] }),
    JSON.stringify({
      format: 2,
      decisions: [
        {
          entry: "src/main.ts",
          target: "linux",
          compiler: key.compiler,
          packages: [
            { name: "sdk", version: "1.2.3", dir: "x", rule: "guess", class: "", reason: "" },
          ],
          modules: [],
        },
      ],
    }),
  ]) {
    writeFileSync(p.file, text);
    expect(readIslandDecision(p.file, key, auto), text).toBeNull();
  }
  expect(writeIslandDecision(p.file, key, auto, state([sdk]), "compiles")?.first).toBe(true);
  expect(readIslandDecision(p.file, key, auto)!.packages.size).toBe(1);
});

test("the digest follows the file's bytes", () => {
  const p = project();
  expect(islandDecisionDigest(undefined)).toBe("");
  expect(islandDecisionDigest(p.file)).toBe("#none");
  writeIslandDecision(p.file, keyOf(p), auto, state([]), "compiles");
  const empty = islandDecisionDigest(p.file);
  expect(empty).toMatch(/^#[0-9a-f]{64}$/);
  writeIslandDecision(p.file, keyOf(p), auto, state([p.install("sdk", "1.2.3")]), "compiles");
  expect(islandDecisionDigest(p.file)).not.toBe(empty);
});

test("the project's key names the file unless the options name one or turn it off", () => {
  const p = project();
  // No package.json key: nothing.
  writeFileSync(join(p.dir, "package.json"), JSON.stringify({ name: "app" }));
  expect(withRecordedDecision(p.entry, undefined)).toBeUndefined();
  // `true` is scriptc-islands.json beside the package.json.
  writeFileSync(
    join(p.dir, "package.json"),
    JSON.stringify({ name: "app", scriptc: { nodeIslands: { decision: true } } }),
  );
  expect(withRecordedDecision(p.entry, undefined)).toEqual({ decision: p.file });
  expect(withRecordedDecision(p.entry, { islands: ["sdk"] })).toEqual({
    islands: ["sdk"],
    decision: p.file,
  });
  // The command line's file wins, and its switch turns the project's off.
  const flag = join(p.dir, "elsewhere.json");
  expect(withRecordedDecision(p.entry, { decision: flag })).toEqual({ decision: flag });
  const ignored = withRecordedDecision(p.entry, { ignoreDecision: true });
  expect(ignored).toEqual({ ignoreDecision: true });
  // Such a build is another build to every cache.
  expect(nodeIslandOptionsKey(ignored)).not.toBe(nodeIslandOptionsKey(undefined));
  expect(nodeIslandOptionsKey(ignored)).not.toBe(nodeIslandOptionsKey({ decision: p.file }));
  // A path is relative to the package.json.
  writeFileSync(
    join(p.dir, "package.json"),
    JSON.stringify({ name: "app", scriptc: { nodeIslands: { decision: "build/islands.json" } } }),
  );
  expect(withRecordedDecision(p.entry, undefined)).toEqual({
    decision: join(p.dir, "build", "islands.json"),
  });
  // Anything else is SC8004, not a silently ignored setting.
  const bad = parseProjectConfig(
    join(p.dir, "package.json"),
    JSON.stringify({ scriptc: { nodeIslands: { decision: 3 } } }),
  );
  expect(bad.nodeIslands.decision).toBeNull();
  expect(bad.diagnostics.map((d) => d.code)).toEqual(["SC8004"]);
  expect(bad.diagnostics[0]!.message).toContain("scriptc.nodeIslands.decision");
});

test("the islands the first decision makes from the load are listed and never replayed", () => {
  const p = project();
  const grown = p.install("grown", "1.0.0", "lowering");
  // A package the load refused and a marked module: no rule grew them.
  const { rule: _rule, ...refused } = p.install("refused", "2.0.0");
  const marked: IslandModule = {
    file: join(p.dir, "src", "plugin.js").split("\\").join("/"),
    class: "marked",
    reason: "marked with --node-island",
    decision: "marked",
  };
  const key = keyOf(p);
  const all = state([grown, refused], [p.legacy, marked]);
  const change = writeIslandDecision(
    p.file,
    key,
    auto,
    state([grown], [p.legacy]),
    "compiles",
    all,
  )!;
  expect(change.packages).toBe(2);
  expect(change.modules).toBe(2);
  expect(change.lines).toEqual([
    "+ grown@1.0.0 (lowering): SC1090: grown refused",
    "+ refused@2.0.0 (load): SC1090: refused refused",
    "+ module src/legacy.js (lowering): R2.4 sloppy-mode semantics: a 'with' statement",
    "+ module src/plugin.js (load): marked with --node-island",
  ]);
  const section = fileJson(p.file).decisions[0]!;
  expect(section.packages.map((entry) => [entry["name"], entry["rule"]])).toEqual([
    ["grown", "lowering"],
    ["refused", "load"],
  ]);
  expect(section.modules.map((entry) => [entry["file"], entry["rule"]])).toEqual([
    ["src/legacy.js", "lowering"],
    ["src/plugin.js", "load"],
  ]);
  // A replay starts from what a rule grew; the load decides the rest again.
  const read = readIslandDecision(p.file, key, auto)!;
  expect([...read.packages.keys()]).toEqual(["grown"]);
  expect([...read.modules.keys()]).toEqual([p.legacy.file]);
  expect(read.gone.size).toBe(0);
  // The check compares them all.
  expect(compareIslandDecision(p.file, key, state([grown], [p.legacy]), "compiles", all)).toEqual(
    [],
  );
  expect(compareIslandDecision(p.file, key, state([grown], [p.legacy]), "compiles", null)).toEqual([
    "- refused@2.0.0",
    "- module src/plugin.js",
  ]);
  // A package a rule grows in one build and the load decides in another.
  expect(compareIslandDecision(p.file, key, state([], [p.legacy]), "compiles", all)).toEqual([
    "~ grown: rule lowering -> load",
  ]);
});
