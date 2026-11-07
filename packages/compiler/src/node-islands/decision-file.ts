/* The recorded island decision (`--node-island-decision=<file>`).
 *
 * A build decides its Node islands in rounds (executable/prepare.ts): it
 * lowers the program, islands the packages and modules whose lowering
 * refused, loads again and lowers again, until a round adds nothing. Only
 * the last round's result is the build's. On a large program the earlier
 * rounds are most of the build, and between two builds of the same program
 * their answer rarely changes.
 *
 * The file keeps that answer: the state the last round started from — the
 * island packages with their class and first reason, the island modules, and
 * whether a fence rule may still run. A build that finds the file starts its
 * first round there, so it is that last round run directly. Nothing else
 * about the round changes: the first decision (refused, marked and patched
 * packages) is made from the load as always, and the lowering's own
 * refusals still grow the set and start another round, after which the file
 * holds the grown set. An entry whose package directory or module file is
 * gone, whose version changed, or that the policy now keeps native or
 * unloaded is dropped and decided again by the rounds.
 *
 * What a replay cannot notice is an island the program no longer needs: the
 * package would have to be lowered natively to find out, which is the round
 * the file saves. Such a package keeps running in Node, correctly, until
 * the file is deleted and the build decides from scratch. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { packageVersionOf } from "./origin.js";
import { nodeIslandOptionsKey, type NodeIslandOptions, type NodeIslandPolicy } from "./policy.js";

/** What one island round starts from, and so what a build's last round
 * leaves for the next build. */
export interface IslandRoundState {
  packages: ReadonlyMap<string, IslandPackage>;
  modules: ReadonlyMap<string, IslandModule>;
  /** Whether the round may still run a fence rule (false after a
   * fence-report retry and inside a fence attempt). */
  retryFences: boolean;
}

const FORMAT = 1;

/** What a recorded decision was decided under, beside the program itself:
 * the island policy's command-line half, the npm-static request and the
 * target platform (a lowering refuses different things for different
 * targets). A file recorded under another key is not replayed. */
export function islandDecisionKey(
  options: NodeIslandOptions | undefined,
  npmStatic: readonly string[] | string | undefined,
  platform: string,
): string {
  const policy: NodeIslandOptions = {
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    ...(options?.islands !== undefined ? { islands: options.islands } : {}),
    ...(options?.native !== undefined ? { native: options.native } : {}),
  };
  const request =
    npmStatic === undefined ? "" : typeof npmStatic === "string" ? npmStatic : npmStatic.join(",");
  return `${nodeIslandOptionsKey(policy)}\n${request}\n${platform}`;
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

/** The file's text for a round state: packages by name and modules by file,
 * so the same decision is the same bytes. */
export function serializeIslandDecision(
  file: string,
  entryPath: string,
  key: string,
  state: IslandRoundState,
): string {
  const base = dirname(resolve(file));
  const packages = [...state.packages.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => ({
      name: p.name,
      version: p.version,
      dir: recorded(base, p.dir),
      class: p.class,
      reason: p.reason,
    }));
  const modules = [...state.modules.values()]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((m) => ({
      file: recorded(base, m.file),
      class: m.class,
      reason: m.reason,
      decision: m.decision,
    }));
  return `${JSON.stringify(
    {
      format: FORMAT,
      entry: recorded(base, entryPath),
      policy: key,
      retryFences: state.retryFences,
      packages,
      modules,
    },
    null,
    2,
  )}\n`;
}

/** The round state `file` records for this entry under this policy, or null
 * when there is nothing to replay: no file, a file this compiler does not
 * read, or one recorded for another entry or policy. The automatic policy
 * alone grows islands from a lowering, so only it replays. A dropped entry
 * turns the fence rules back on: the recorded round no longer stands as the
 * last one. */
export function readIslandDecision(
  file: string,
  entryPath: string,
  key: string,
  policy: NodeIslandPolicy,
): IslandRoundState | null {
  if (policy.mode !== "auto") return null;
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
  if (!isRecord(parsed)) return null;
  if (parsed["format"] !== FORMAT || parsed["policy"] !== key) return null;
  const base = dirname(resolve(file));
  if (parsed["entry"] !== recorded(base, entryPath)) return null;
  const listedPackages = parsed["packages"];
  const listedModules = parsed["modules"];
  if (!Array.isArray(listedPackages) || !Array.isArray(listedModules)) return null;
  let complete = true;
  const packages = new Map<string, IslandPackage>();
  for (const entry of listedPackages) {
    if (!isRecord(entry)) return null;
    const name = entry["name"];
    const version = entry["version"];
    const dir = entry["dir"];
    const cls = entry["class"];
    const reason = entry["reason"];
    if (
      typeof name !== "string" ||
      (version !== null && typeof version !== "string") ||
      typeof dir !== "string" ||
      typeof cls !== "string" ||
      typeof reason !== "string"
    )
      return null;
    const at = slashed(resolve(base, dir));
    if (
      policy.forcedNative.has(name) ||
      policy.unloaded.has(name) ||
      !existsSync(at) ||
      packageVersionOf(at) !== version
    ) {
      complete = false;
      continue;
    }
    packages.set(name, { name, version, dir: at, class: cls, reason });
  }
  const modules = new Map<string, IslandModule>();
  for (const entry of listedModules) {
    if (!isRecord(entry)) return null;
    const path = entry["file"];
    const cls = entry["class"];
    const reason = entry["reason"];
    const decision = entry["decision"];
    if (
      typeof path !== "string" ||
      typeof cls !== "string" ||
      typeof reason !== "string" ||
      (decision !== "marked" && decision !== "auto")
    )
      return null;
    const at = slashed(resolve(base, path));
    if (!existsSync(at)) {
      complete = false;
      continue;
    }
    modules.set(at, { file: at, class: cls, reason, decision });
  }
  return {
    packages,
    modules,
    retryFences: complete ? parsed["retryFences"] !== false : true,
  };
}

/** Writes the decision a build reached, unless the file already says so.
 * The automatic policy alone has one to keep. Returns whether it wrote. */
export function writeIslandDecision(
  file: string,
  entryPath: string,
  key: string,
  policy: NodeIslandPolicy,
  state: IslandRoundState,
): boolean {
  if (policy.mode !== "auto") return false;
  const text = serializeIslandDecision(file, entryPath, key, state);
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    // No file yet (or an unreadable one): write it below.
  }
  mkdirSync(dirname(resolve(file)), { recursive: true });
  // A reader never sees half a file: the text lands under another name in
  // the same directory and is renamed over the old one.
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, text);
  renameSync(pending, file);
  return true;
}
