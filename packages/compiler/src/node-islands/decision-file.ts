/* The recorded island decision (`--node-island-decision=<file>`, or the
 * project's `scriptc.nodeIslands.decision`).
 *
 * A build decides its Node islands in rounds (executable/prepare.ts): it
 * lowers the program, islands the packages and modules whose lowering
 * refused, loads again and lowers again, until a round adds nothing. Only
 * the last round's result is the build's. On a large program the earlier
 * rounds are most of the build, and between two builds of the same program
 * their answer rarely changes.
 *
 * The file keeps that answer, one section per entry and set of options: the
 * islands the last round started from — the island packages with the rule
 * that grew each, its class and first reason, and the island modules. A
 * build that finds its section starts its first round there. Nothing else
 * about the round changes: the first decision (refused, marked and patched
 * packages) is made from the load as always, and the lowering's refusals and
 * the fence rules judge the program as it is now, so a dependency added
 * since the record gets the island a build from scratch gives it, by one
 * more round, after which the section holds the grown set.
 *
 * The decision is a function of the compiler, the options that steer it, the
 * installed packages and the program's source. A replay answers for each:
 *
 *  - another compiler release: the section is decided from scratch;
 *  - other options or another target: another section;
 *  - a recorded package whose directory is gone, whose version changed, or
 *    that the policy now keeps native or unloaded: dropped, with every
 *    package that is an island only because it imports that one, and decided
 *    again by the rounds;
 *  - a recorded package the program no longer imports, or a recorded module
 *    it no longer loads: dropped once the first load shows it
 *    (`admitRecorded`);
 *  - an island a fence rule added for a failing build, when the build now
 *    compiles, or for a compiling one that now fails: decided again
 *    (`staleByOutcome`).
 *
 * What a replay cannot notice is a still-imported package that would now
 * compile: an edit to the program, another package's new version or a type
 * patch may have removed the refusal, and only lowering the package natively
 * can tell, which is the round the file saves. Such a package keeps running
 * in Node, correctly. `compareIslandDecision` is the check for it: it holds
 * a decision made from scratch against the section. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AnalyzeOptions, CompileRequestOptions } from "../compile-types.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { readProjectConfig } from "../project-config.js";
import type { IslandModule, IslandPackage, IslandRule } from "./boundary.js";
import { packageVersionOf } from "./origin.js";
import {
  isModuleIslandArgument,
  nodeIslandOptionsKey,
  type NodeIslandOptions,
  type NodeIslandPolicy,
} from "./policy.js";
import type { NodeIslandScan } from "./scan.js";

/** The islands one island round starts from, and so what a build's last
 * round leaves for the next build. Whether that round could still run a
 * fence rule is not part of it: the rule had run for the program as it was,
 * and a replay asks it again for the program as it is. */
export interface IslandRoundState {
  packages: ReadonlyMap<string, IslandPackage>;
  modules: ReadonlyMap<string, IslandModule>;
}

/** How the build that recorded a section ended, once its lowering had run. */
export type IslandOutcome = "compiles" | "fails";

const FORMAT = 2;

const RULES: readonly IslandRule[] = [
  "refusal",
  "preflight",
  "lowering",
  "esm-importer",
  "fence-report",
  "fence-sure",
];

function ruleOf(text: string): IslandRule | undefined {
  for (const rule of RULES) if (rule === text) return rule;
  return undefined;
}

/** The outcome a fence rule's islands were decided for, or null for a rule
 * that does not read the build's outcome. The fence report runs only for a
 * build that fails, so the islands a failing build got from it say nothing
 * once the program compiles; a fence that surely fires islands its package
 * only when the build with the island compiles, so those islands say nothing
 * once it fails (a build from scratch would then keep the native build).
 * A rule that stops depending on the outcome loses its line here. */
function holdsWhile(rule: IslandRule | undefined): IslandOutcome | null {
  if (rule === "fence-report") return "fails";
  if (rule === "fence-sure") return "compiles";
  return null;
}

/** What a section was decided under, beside the program itself: the entry,
 * the target platform (a lowering refuses different things for different
 * targets), the command-line half of the island policy, the npm-static
 * request and the tier mode. A section is found by these; the compiler
 * release says whether what it holds may still be replayed. */
export interface IslandDecisionKey {
  entry: string;
  target: string;
  /** `--node-island` values: package names, and absolute module paths. */
  islands: string[];
  /** `--native` values. */
  native: string[];
  /** "" for none, "auto", or the sorted names joined by commas. */
  npmStatic: string;
  /** `--tier`, "" for the default. */
  tier: string;
  compiler: string;
}

export function islandDecisionKey(
  entryPath: string,
  options: NodeIslandOptions | undefined,
  npmStatic: readonly string[] | string | undefined,
  tier: string | undefined,
  platform: string,
): IslandDecisionKey {
  return {
    entry: resolve(entryPath),
    target: platform,
    islands: [...(options?.islands ?? [])].sort(),
    native: [...(options?.native ?? [])].sort(),
    npmStatic:
      npmStatic === undefined
        ? ""
        : typeof npmStatic === "string"
          ? npmStatic
          : [...npmStatic].sort().join(","),
    tier: tier ?? "",
    compiler: compilerReleaseVersion(),
  };
}

/** The decision file a build or analysis of `entryPath` uses: the one the
 * options name, else the project's (`scriptc.nodeIslands.decision`), unless
 * the options turn the project's off. The returned options carry it as
 * `decision`, so everything downstream reads one field. */
export function withRecordedDecision(
  entryPath: string,
  options: NodeIslandOptions | undefined,
): NodeIslandOptions | undefined {
  if (options !== undefined && options.ignoreDecision === true) {
    // The mark stays in the options: a build that ignores the project's file
    // is another build to every cache (nodeIslandOptionsKey), so its result
    // is never served to one that replays the file.
    const { decision: _file, ...rest } = options;
    return rest;
  }
  if (options !== undefined && options.decision !== undefined) return options;
  const configured = readProjectConfig(entryPath).nodeIslands.decision;
  if (configured === null) return options;
  return { ...options, decision: configured };
}

/** `options` with the decision file a build of `entryPath` uses in
 * `nodeIslands.decision` (withRecordedDecision): what `compile` and the
 * island decision's check do before anything reads the options. */
export function compileOptionsWithDecision(
  entryPath: string,
  options: CompileRequestOptions,
): CompileRequestOptions {
  const nodeIslands = withRecordedDecision(entryPath, options.nodeIslands);
  if (nodeIslands === options.nodeIslands) return options;
  const { nodeIslands: _previous, ...rest } = options;
  return nodeIslands === undefined ? rest : { ...rest, nodeIslands };
}

/** The same for an analysis. */
export function analyzeOptionsWithDecision(
  entryPath: string,
  options: AnalyzeOptions,
): AnalyzeOptions {
  const nodeIslands = withRecordedDecision(entryPath, options.nodeIslands);
  if (nodeIslands === options.nodeIslands) return options;
  const { nodeIslands: _previous, ...rest } = options;
  return nodeIslands === undefined ? rest : { ...rest, nodeIslands };
}

/** The cache-key part for a recorded island decision: the digest of the
 * file's bytes, or of nothing while the file does not exist yet. Empty
 * without the option. A recorded decision changes what a build compiles,
 * and the option names only its path. */
export function islandDecisionDigest(file: string | undefined): string {
  if (file === undefined) return "";
  try {
    return `#${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  } catch {
    return "#none";
  }
}

/** The island policy's identity for a cache that must tell two recorded
 * decisions apart: the options' own key and the file's digest. */
export function nodeIslandDecisionKey(options: NodeIslandOptions | undefined): string {
  return nodeIslandOptionsKey(options) + islandDecisionDigest(options?.decision);
}

function slashed(path: string): string {
  return path.split("\\").join("/");
}

/** A path as the file spells it: relative to the file's own directory, so a
 * project that moves keeps its decision. */
function recorded(base: string, path: string): string {
  const rel = slashed(relative(base, path));
  return rel === "" ? "." : rel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether two spellings name one directory or file (a package directory
 * the checker reached through a link is spelled by its target). */
function samePlace(a: string, b: string): boolean {
  if (slashed(a) === slashed(b)) return true;
  try {
    return slashed(realpathSync(a)) === slashed(realpathSync(b));
  } catch {
    return false;
  }
}

/** One package as a section lists it. `rule` and `follows` are "" when the
 * package has none. */
interface SectionPackage {
  name: string;
  version: string | null;
  dir: string;
  rule: string;
  follows: string;
  class: string;
  reason: string;
}

interface SectionModule {
  file: string;
  class: string;
  reason: string;
  decision: string;
}

/** One section, with every path as the file spells it. `outcome` is "" for
 * a section whose islands do not depend on one. */
interface Section {
  entry: string;
  target: string;
  islands: string[];
  native: string[];
  npmStatic: string;
  tier: string;
  compiler: string;
  outcome: string;
  packages: SectionPackage[];
  modules: SectionModule[];
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The section a build under `key` writes for the islands its returned
 * round started from. The outcome is kept only while an island depends on
 * it, so a program without such islands has the same section whether it
 * compiles or not. */
function sectionOf(
  file: string,
  key: IslandDecisionKey,
  state: IslandRoundState,
  outcome: IslandOutcome,
): Section {
  const base = dirname(resolve(file));
  const packages = [...state.packages.values()]
    .sort((a, b) => byText(a.name, b.name))
    .map(
      (p): SectionPackage => ({
        name: p.name,
        version: p.version,
        dir: recorded(base, p.dir),
        rule: p.rule ?? "",
        follows: p.follows ?? "",
        class: p.class,
        reason: p.reason,
      }),
    );
  const modules = [...state.modules.values()]
    .sort((a, b) => byText(a.file, b.file))
    .map(
      (m): SectionModule => ({
        file: recorded(base, m.file),
        class: m.class,
        reason: m.reason,
        decision: m.decision,
      }),
    );
  let dependsOnOutcome = false;
  for (const p of state.packages.values()) if (holdsWhile(p.rule) !== null) dependsOnOutcome = true;
  return {
    entry: recorded(base, key.entry),
    target: key.target,
    islands: key.islands.map((value) =>
      isModuleIslandArgument(value) && isAbsolute(value) ? recorded(base, value) : value,
    ),
    native: key.native,
    npmStatic: key.npmStatic,
    tier: key.tier,
    compiler: key.compiler,
    outcome: dependsOnOutcome ? outcome : "",
    packages,
    modules,
  };
}

/** A section as the file's JSON holds it: options a build did not pass and
 * fields a package does not have are left out. */
function sectionJson(section: Section): Record<string, unknown> {
  const options = {
    ...(section.islands.length > 0 ? { nodeIsland: section.islands } : {}),
    ...(section.native.length > 0 ? { native: section.native } : {}),
    ...(section.npmStatic === ""
      ? {}
      : { npmStatic: section.npmStatic === "auto" ? "auto" : section.npmStatic.split(",") }),
    ...(section.tier === "" ? {} : { tier: section.tier }),
  };
  return {
    entry: section.entry,
    target: section.target,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    compiler: section.compiler,
    ...(section.outcome === "" ? {} : { outcome: section.outcome }),
    packages: section.packages.map((p) => ({
      name: p.name,
      version: p.version,
      dir: p.dir,
      ...(p.rule === "" ? {} : { rule: p.rule }),
      ...(p.follows === "" ? {} : { follows: p.follows }),
      class: p.class,
      reason: p.reason,
    })),
    modules: section.modules.map((m) => ({
      file: m.file,
      class: m.class,
      reason: m.reason,
      decision: m.decision,
    })),
  };
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

/** One section read back, or null when it is not one this compiler wrote. */
function parseSection(value: unknown): Section | null {
  if (!isRecord(value)) return null;
  const entry = value["entry"];
  const target = value["target"];
  const compiler = value["compiler"];
  const outcome = value["outcome"] ?? "";
  if (typeof entry !== "string" || typeof target !== "string" || typeof compiler !== "string")
    return null;
  if (outcome !== "" && outcome !== "compiles" && outcome !== "fails") return null;
  const options = value["options"] ?? {};
  if (!isRecord(options)) return null;
  const islands = stringList(options["nodeIsland"]);
  const native = stringList(options["native"]);
  const requested = options["npmStatic"];
  const npmStatic =
    requested === undefined
      ? ""
      : requested === "auto"
        ? "auto"
        : (stringList(requested)?.join(",") ?? null);
  const tier = options["tier"] ?? "";
  if (islands === null || native === null || npmStatic === null || typeof tier !== "string")
    return null;
  const listedPackages = value["packages"];
  const listedModules = value["modules"];
  if (!Array.isArray(listedPackages) || !Array.isArray(listedModules)) return null;
  const packages: SectionPackage[] = [];
  for (const listed of listedPackages as unknown[]) {
    if (!isRecord(listed)) return null;
    const name = listed["name"];
    const version = listed["version"];
    const dir = listed["dir"];
    const rule = listed["rule"] ?? "";
    const follows = listed["follows"] ?? "";
    const cls = listed["class"];
    const reason = listed["reason"];
    if (
      typeof name !== "string" ||
      (version !== null && typeof version !== "string") ||
      typeof dir !== "string" ||
      typeof rule !== "string" ||
      typeof follows !== "string" ||
      typeof cls !== "string" ||
      typeof reason !== "string"
    )
      return null;
    if (rule !== "" && ruleOf(rule) === undefined) return null;
    packages.push({ name, version, dir, rule, follows, class: cls, reason });
  }
  const modules: SectionModule[] = [];
  for (const listed of listedModules as unknown[]) {
    if (!isRecord(listed)) return null;
    const path = listed["file"];
    const cls = listed["class"];
    const reason = listed["reason"];
    const decision = listed["decision"];
    if (
      typeof path !== "string" ||
      typeof cls !== "string" ||
      typeof reason !== "string" ||
      (decision !== "marked" && decision !== "auto")
    )
      return null;
    modules.push({ file: path, class: cls, reason, decision });
  }
  return {
    entry,
    target,
    islands,
    native,
    npmStatic,
    tier,
    compiler,
    outcome,
    packages,
    modules,
  };
}

/** The file's sections, or null when there is no file or it is not one this
 * compiler reads (another format, or text that is not a decision file). */
function readSections(file: string): Section[] | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["format"] !== FORMAT) return null;
  const listed = parsed["decisions"];
  if (!Array.isArray(listed)) return null;
  const sections: Section[] = [];
  for (const value of listed as unknown[]) {
    const section = parseSection(value);
    if (section === null) return null;
    sections.push(section);
  }
  return sections;
}

/** Whether two sections are the same entry built with the same options. */
function sameBuild(a: Section, b: Section): boolean {
  return (
    a.entry === b.entry &&
    a.target === b.target &&
    a.islands.join("\n") === b.islands.join("\n") &&
    a.native.join("\n") === b.native.join("\n") &&
    a.npmStatic === b.npmStatic &&
    a.tier === b.tier
  );
}

function sectionText(section: Section): string {
  return JSON.stringify(sectionJson(section), null, 2);
}

/** The recorded section for `key`, or null. */
function findSection(file: string, key: IslandDecisionKey): Section | null {
  const sections = readSections(file);
  if (sections === null) return null;
  const wanted = sectionOf(file, key, { packages: new Map(), modules: new Map() }, "compiles");
  for (const section of sections) if (sameBuild(section, wanted)) return section;
  return null;
}

/** The packages of `packages` without `names`, and without every package
 * that follows one that left (an ES-module importer of a CommonJS island is
 * an island only while that island is one). `gone` receives each package
 * that left with why. */
export function withoutPackages(
  packages: ReadonlyMap<string, IslandPackage>,
  names: ReadonlyMap<string, string>,
  gone: Map<string, string>,
): Map<string, IslandPackage> {
  const kept = new Map<string, IslandPackage>();
  for (const [name, island] of packages) {
    const why = names.get(name);
    if (why === undefined) kept.set(name, island);
    else gone.set(name, why);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, island] of kept) {
      if (island.follows === undefined || kept.has(island.follows)) continue;
      // The island it follows may be one the first decision makes from the
      // load (never recorded): only a package that left takes it along.
      if (!gone.has(island.follows)) continue;
      kept.delete(name);
      gone.set(name, `it is an island only with '${island.follows}'`);
      changed = true;
    }
  }
  return kept;
}

/** A recorded decision as a build starts from it. */
export interface RecordedDecision extends IslandRoundState {
  /** The outcome of the build that recorded it, when its islands depend on
   * one. */
  outcome: IslandOutcome | null;
  /** The recorded islands that are not replayed, each with why. */
  gone: Map<string, string>;
}

/** The islands `file` records for this build, or null when there is nothing
 * to replay: no file, a file this compiler does not read, no section for
 * this entry and these options, or a section another compiler release
 * recorded. The automatic policy alone grows islands from a lowering, so
 * only it replays. */
export function readIslandDecision(
  file: string,
  key: IslandDecisionKey,
  policy: NodeIslandPolicy,
): RecordedDecision | null {
  if (policy.mode !== "auto") return null;
  const section = findSection(file, key);
  if (section === null || section.compiler !== key.compiler) return null;
  const base = dirname(resolve(file));
  const packages = new Map<string, IslandPackage>();
  const leaving = new Map<string, string>();
  for (const entry of section.packages) {
    const at = slashed(resolve(base, entry.dir));
    const rule = ruleOf(entry.rule);
    packages.set(entry.name, {
      name: entry.name,
      version: entry.version,
      dir: at,
      class: entry.class,
      reason: entry.reason,
      ...(rule === undefined ? {} : { rule }),
      ...(entry.follows === "" ? {} : { follows: entry.follows }),
    });
    if (policy.forcedNative.has(entry.name)) leaving.set(entry.name, "the policy keeps it native");
    else if (policy.unloaded.has(entry.name)) leaving.set(entry.name, "the policy never loads it");
    else if (!existsSync(at)) leaving.set(entry.name, "its directory is gone");
    else if (packageVersionOf(at) !== entry.version)
      leaving.set(
        entry.name,
        `its version changed from ${entry.version ?? "none"} to ${packageVersionOf(at) ?? "none"}`,
      );
  }
  const gone = new Map<string, string>();
  const kept = withoutPackages(packages, leaving, gone);
  const modules = new Map<string, IslandModule>();
  for (const entry of section.modules) {
    const at = slashed(resolve(base, entry.file));
    if (!existsSync(at)) {
      gone.set(at, "the file is gone");
      continue;
    }
    modules.set(at, {
      file: at,
      class: entry.class,
      reason: entry.reason,
      decision: entry.decision === "marked" ? "marked" : "auto",
    });
  }
  return {
    packages: kept,
    modules,
    outcome:
      section.outcome === "compiles" ? "compiles" : section.outcome === "fails" ? "fails" : null,
    gone,
  };
}

/** The recorded islands the program as it is now still has a use for, by
 * the first load's scan: a package some module still imports, and a module
 * the program still loads. An island nothing imports would otherwise stay
 * one for good, with a note for an island no code calls and its files in the
 * executable. A build from scratch can only island what it loads, so this
 * drops nothing such a build would keep. `gone` receives what left. */
export function admitRecorded(
  recordedState: IslandRoundState,
  scan: NodeIslandScan,
  gone: Map<string, string>,
): IslandRoundState {
  const leaving = new Map<string, string>();
  for (const [name, island] of recordedState.packages) {
    let imported = false;
    for (const edge of scan.edges) {
      if (edge.shim || edge.to !== name) continue;
      // An import the scan could not resolve to installed JavaScript (a
      // package only `require` conditions export) still names the package.
      if (edge.toDir === null || samePlace(edge.toDir, island.dir)) {
        imported = true;
        break;
      }
    }
    if (!imported) leaving.set(name, "the program no longer imports it");
  }
  const packages = withoutPackages(recordedState.packages, leaving, gone);
  const modules = new Map<string, IslandModule>();
  for (const [file, island] of recordedState.modules) {
    if (scan.modules.some((m) => samePlace(m.file, file))) modules.set(file, island);
    else gone.set(file, "the program no longer loads it");
  }
  return { packages, modules };
}

/** The islands of a replayed set that were decided for the other outcome:
 * each with why it is decided again. `outcome` is the one the record was
 * made under, `ok` whether the replayed build compiled. */
export function staleByOutcome(
  outcome: IslandOutcome | null,
  packages: ReadonlyMap<string, IslandPackage>,
  ok: boolean,
): Map<string, string> {
  const stale = new Map<string, string>();
  if (outcome === null || (outcome === "compiles") === ok) return stale;
  for (const [name, island] of packages) {
    if (holdsWhile(island.rule) !== outcome) continue;
    stale.set(
      name,
      ok
        ? "a failing build asked for it and the program now compiles"
        : "a compiling build asked for it and the program now fails",
    );
  }
  return stale;
}

/** What a build changed in the file. */
export interface IslandDecisionChange {
  file: string;
  /** Whether the file held no section for this build before. */
  first: boolean;
  /** The lines of the change, as `describeDifference` words them. */
  lines: string[];
  packages: number;
  modules: number;
}

/** How `next` differs from `previous`, one line per island: `+` for an
 * island only `next` has, `-` for one only `previous` has, `~` for a change
 * to one both have. `gone` words why an island left, where a build knows. */
function describeDifference(
  previous: Section | null,
  next: Section,
  gone: ReadonlyMap<string, string>,
  base: string,
): string[] {
  const lines: string[] = [];
  if (previous !== null && previous.compiler !== next.compiler)
    lines.push(`~ compiler: ${previous.compiler} -> ${next.compiler}`);
  if (previous !== null && previous.outcome !== next.outcome)
    lines.push(`~ outcome: ${previous.outcome || "none"} -> ${next.outcome || "none"}`);
  const before = new Map<string, SectionPackage>();
  for (const p of previous?.packages ?? []) before.set(p.name, p);
  const after = new Map<string, SectionPackage>();
  for (const p of next.packages) after.set(p.name, p);
  const versioned = (p: SectionPackage): string =>
    p.version === null ? p.name : `${p.name}@${p.version}`;
  for (const p of next.packages) {
    const was = before.get(p.name);
    if (was === undefined) {
      lines.push(`+ ${versioned(p)}${p.rule === "" ? "" : ` (${p.rule})`}: ${p.reason}`);
      continue;
    }
    const changes: string[] = [];
    if (was.version !== p.version)
      changes.push(`version ${was.version ?? "none"} -> ${p.version ?? "none"}`);
    if (was.dir !== p.dir) changes.push(`directory ${was.dir} -> ${p.dir}`);
    if (was.rule !== p.rule) changes.push(`rule ${was.rule || "none"} -> ${p.rule || "none"}`);
    if (was.follows !== p.follows)
      changes.push(`follows ${was.follows || "none"} -> ${p.follows || "none"}`);
    if (was.class !== p.class || was.reason !== p.reason) changes.push(`reason: ${p.reason}`);
    if (changes.length > 0) lines.push(`~ ${p.name}: ${changes.join(", ")}`);
  }
  for (const p of previous?.packages ?? []) {
    if (after.has(p.name)) continue;
    const why = gone.get(p.name);
    lines.push(`- ${versioned(p)}${why === undefined ? "" : `: ${why}`}`);
  }
  const modulesBefore = new Map<string, SectionModule>();
  for (const m of previous?.modules ?? []) modulesBefore.set(m.file, m);
  const modulesAfter = new Set<string>();
  for (const m of next.modules) {
    modulesAfter.add(m.file);
    const was = modulesBefore.get(m.file);
    if (was === undefined) lines.push(`+ module ${m.file}: ${m.reason}`);
    else if (was.class !== m.class || was.reason !== m.reason || was.decision !== m.decision)
      lines.push(`~ module ${m.file}: reason: ${m.reason}`);
  }
  for (const m of previous?.modules ?? []) {
    if (modulesAfter.has(m.file)) continue;
    const why = gone.get(slashed(resolve(base, m.file)));
    lines.push(`- module ${m.file}${why === undefined ? "" : `: ${why}`}`);
  }
  return lines;
}

/** Writes the decision a build reached into its section, unless the section
 * already says so. Every other section stays as it is. The automatic policy
 * alone has a decision to keep. Returns what changed, or null. */
export function writeIslandDecision(
  file: string,
  key: IslandDecisionKey,
  policy: NodeIslandPolicy,
  state: IslandRoundState,
  outcome: IslandOutcome,
  gone: ReadonlyMap<string, string> = new Map(),
): IslandDecisionChange | null {
  if (policy.mode !== "auto") return null;
  const section = sectionOf(file, key, state, outcome);
  // Read at the moment of writing: another entry's build may have written
  // its own section since this build read the file.
  const sections = readSections(file) ?? [];
  let previous: Section | null = null;
  const others: Section[] = [];
  for (const other of sections) {
    if (sameBuild(other, section)) previous = other;
    else others.push(other);
  }
  if (previous !== null && sectionText(previous) === sectionText(section)) return null;
  const all = [...others, section].sort(
    (a, b) =>
      byText(a.entry, b.entry) ||
      byText(a.target, b.target) ||
      byText(sectionText(a), sectionText(b)),
  );
  const text = `${JSON.stringify({ format: FORMAT, decisions: all.map(sectionJson) }, null, 2)}\n`;
  mkdirSync(dirname(resolve(file)), { recursive: true });
  // A reader never sees half a file: the text lands under another name in
  // the same directory and is renamed over the old one.
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, text);
  renameSync(pending, file);
  return {
    file,
    first: previous === null,
    lines: describeDifference(previous, section, gone, dirname(resolve(file))),
    packages: section.packages.length,
    modules: section.modules.length,
  };
}

/** The line a build prints when it wrote the file. */
export function describeIslandDecisionChange(change: IslandDecisionChange, cwd: string): string {
  const relativeToCwd = recorded(cwd, change.file);
  const where = relativeToCwd.startsWith("../") ? slashed(change.file) : relativeToCwd;
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const size =
    change.packages === 0 && change.modules === 0
      ? "no islands"
      : [
          ...(change.packages > 0 ? [count(change.packages, "package")] : []),
          ...(change.modules > 0 ? [count(change.modules, "module")] : []),
        ].join(", ");
  const head = `scriptc: ${change.first ? "recorded" : "updated"} the Node island decision in ${where} (${size})`;
  return change.lines.length === 0
    ? `${head}\n`
    : `${head}\n${change.lines.map((line) => `  ${line}`).join("\n")}\n`;
}

/** How the decision a build from scratch reached differs from what `file`
 * records for it: no line when a build would leave the file as it is. A `+`
 * island is one the file lacks, a `-` island one a build from scratch does
 * not run in Node. */
export function compareIslandDecision(
  file: string,
  key: IslandDecisionKey,
  state: IslandRoundState,
  outcome: IslandOutcome,
): string[] {
  const section = sectionOf(file, key, state, outcome);
  const previous = findSection(file, key);
  if (previous === null)
    return [
      existsSync(file)
        ? "the file records no decision for this entry, target and options"
        : "the file does not exist",
    ];
  if (sectionText(previous) === sectionText(section)) return [];
  return describeDifference(previous, section, new Map(), dirname(resolve(file)));
}
