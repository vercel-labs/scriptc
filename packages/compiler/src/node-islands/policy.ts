/* The Node island policy (DESIGN.md §1.5–§1.6): user code strict, npm
 * lenient. npm code outside the native subset becomes a Node island
 * automatically (`nodeIslands.auto`, `--node-islands=auto`); user modules
 * become islands only when marked (`nodeIslands.modules`,
 * `--node-island=<path>`); `"native"` (`--native=<pkg>`) makes one
 * dependency strict; `--node-islands=off` makes the whole program strict.
 *
 * This version is report-only: the policy decides what WOULD run in Node,
 * and coverage reports it, but code generation does not change. */
import { isAbsolute, join, resolve, dirname } from "node:path";
import type { ProjectConfig } from "../project-config.js";

export type NodeIslandsMode = "auto" | "explicit" | "off";
export const NODE_ISLANDS_MODES: readonly NodeIslandsMode[] = ["auto", "explicit", "off"];

/** The command-line half of the policy (`build`, `run` and `coverage`
 * accept these). */
export interface NodeIslandOptions {
  /** `--node-islands=auto|explicit|off`. */
  mode?: NodeIslandsMode;
  /** `--node-island=<pkg-or-path>`: packages and user modules forced into a
   * Node island. Paths are absolute. */
  islands?: readonly string[];
  /** `--native=<pkg>`: packages that must compile natively. */
  native?: readonly string[];
  /** `--node=<path>`: the node executable recorded for islands. */
  node?: string;
  /** `--strict-user-js`: report R2 constructs in user JavaScript as
   * SC8101–SC8105. */
  strictUserJs?: boolean;
}

export type DecisionSource = "config" | "cli";

export interface UserModulePattern {
  /** An absolute path or glob. */
  pattern: string;
  source: DecisionSource;
}

export interface NodeIslandPolicy {
  mode: NodeIslandsMode;
  /** Where the mode came from (an explicit `"auto": false` reads as
   * "explicit"). */
  modeSource: DecisionSource | "default";
  forcedNode: Map<string, DecisionSource>;
  forcedNative: Map<string, DecisionSource>;
  /** `"unloaded"` packages: never loaded, never islands. */
  unloaded: Set<string>;
  userModules: UserModulePattern[];
  node: string | null;
  strictUserJs: boolean;
}

/** Whether a `--node-island` value names a module rather than a package. */
export function isModuleIslandArgument(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("/") ||
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(value) ||
    value.includes("*")
  );
}

export function nodeIslandPolicy(
  config: ProjectConfig,
  options: NodeIslandOptions = {},
): NodeIslandPolicy {
  const forcedNode = new Map<string, DecisionSource>();
  const forcedNative = new Map<string, DecisionSource>();
  const unloaded = new Set<string>();
  for (const [name, setting] of config.packages) {
    if (setting.unloaded) unloaded.add(name);
    else if (setting.run === "node") forcedNode.set(name, "config");
    else if (setting.run === "native") forcedNative.set(name, "config");
  }
  const userModules: UserModulePattern[] = [];
  const base = config.manifest === null ? process.cwd() : dirname(config.manifest);
  for (const pattern of config.nodeIslands.modules) {
    userModules.push({
      pattern: isAbsolute(pattern) ? pattern : join(base, pattern),
      source: "config",
    });
  }
  for (const value of options.islands ?? []) {
    if (isModuleIslandArgument(value)) {
      userModules.push({ pattern: resolve(value), source: "cli" });
    } else {
      forcedNative.delete(value);
      forcedNode.set(value, "cli");
    }
  }
  for (const name of options.native ?? []) {
    forcedNode.delete(name);
    forcedNative.set(name, "cli");
  }
  let mode: NodeIslandsMode = "auto";
  let modeSource: DecisionSource | "default" = "default";
  if (options.mode !== undefined) {
    mode = options.mode;
    modeSource = "cli";
  } else if (!config.nodeIslands.auto) {
    mode = "explicit";
    modeSource = "config";
  }
  return {
    mode,
    modeSource,
    forcedNode,
    forcedNative,
    unloaded,
    userModules,
    node: options.node ?? config.nodeIslands.node,
    strictUserJs: options.strictUserJs === true,
  };
}

/** Whether a user module is marked to run in a Node island. */
export function isMarkedUserModule(policy: NodeIslandPolicy, file: string): DecisionSource | null {
  const path = file.split("\\").join("/");
  for (const entry of policy.userModules) {
    if (globMatch(entry.pattern.split("\\").join("/"), path)) return entry.source;
  }
  return null;
}

/** Glob matching over `/`-separated paths: `**` spans directories, `*` and
 * `?` stay inside one segment. */
export function globMatch(pattern: string, path: string): boolean {
  return matchSegments(pattern.split("/"), 0, path.split("/"), 0);
}

function matchSegments(pat: string[], pi: number, segs: string[], si: number): boolean {
  if (pi === pat.length) return si === segs.length;
  const p = pat[pi]!;
  if (p === "**") {
    for (let k = si; k <= segs.length; k++) if (matchSegments(pat, pi + 1, segs, k)) return true;
    return false;
  }
  if (si === segs.length) return false;
  return matchSegment(p, 0, segs[si]!, 0) && matchSegments(pat, pi + 1, segs, si + 1);
}

function matchSegment(p: string, pi: number, s: string, si: number): boolean {
  if (pi === p.length) return si === s.length;
  const ch = p.charAt(pi);
  if (ch === "*") {
    for (let k = si; k <= s.length; k++) if (matchSegment(p, pi + 1, s, k)) return true;
    return false;
  }
  if (si === s.length) return false;
  if (ch === "?" || ch === s.charAt(si)) return matchSegment(p, pi + 1, s, si + 1);
  return false;
}

/** The policy's identity for caches: two analyses with the same identity
 * decide the same islands. */
export function nodeIslandOptionsKey(options: NodeIslandOptions | undefined): string {
  if (options === undefined) return "";
  return [
    options.mode ?? "",
    (options.islands ?? []).join(","),
    (options.native ?? []).join(","),
    options.node ?? "",
    options.strictUserJs === true ? "strict-user-js" : "",
  ].join("|");
}
