/* The Node island policy (DESIGN.md §1.5–§1.6): user code strict, npm
 * lenient. npm code outside the native subset becomes a Node island
 * automatically (`nodeIslands.auto`, `--node-islands=auto`); user modules
 * become islands only when marked (`nodeIslands.modules`,
 * `--node-island=<path>`); `"native"` (`--native=<pkg>`) makes one
 * dependency strict; `--node-islands=off` makes the whole program strict.
 * The decision drives code generation: an island package or module is not
 * compiled natively but loaded by the program's Node island. */
import { isAbsolute, join, resolve, dirname } from "node:path";
import { trackedFileExists } from "../frontend/input-tracker.js";
import { packageNameOfSpecifier } from "../frontend/workspace-registry.js";
import type { ProjectConfig } from "../project-config.js";

export type NodeIslandsMode = "auto" | "explicit" | "off";
export const NODE_ISLANDS_MODES: readonly NodeIslandsMode[] = ["auto", "explicit", "off"];

/** The command-line half of the policy (`build`, `run` and `coverage`
 * accept these). */
export interface NodeIslandOptions {
  /** `--node-islands=auto|explicit|off`. */
  mode?: NodeIslandsMode;
  /** `--node-island=<pkg-or-path>`: packages and user modules forced into a
   * Node island, as written (`readNodeIslandMark` reads each). */
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
  /** How the `--node-island` value that gave the pattern was read (command
   * line only). */
  mark?: NodeIslandPathMark;
}

/** A `--node-island` value read as a path or glob over the program's own
 * modules, and why: it is spelled as a path (`explicit`: it starts with `.`
 * or is absolute), it is a glob, its first segment is `node_modules` (which
 * no package is named), or it is a bare spelling that names an existing file
 * while the entry module resolves no package of that name (`file`). */
export interface NodeIslandPathMark {
  kind: "path";
  /** The value as written. */
  value: string;
  /** The absolute path or glob, resolved from the working directory. */
  pattern: string;
  why: "explicit" | "glob" | "node-modules" | "file";
}

/** A `--node-island` value read as a package, and why: no file of that
 * spelling exists (`name`), or one does and the entry module also resolves a
 * package of that name (`installed`): the package wins, because `./` always
 * spells the file. A subpath (`pkg/lib/index.js`) names its package: the
 * package is the unit that runs in an island. */
export interface NodeIslandPackageMark {
  kind: "package";
  /** The value as written. */
  value: string;
  /** The package name (`@scope/name` or `name`). */
  name: string;
  /** The file the value would name as a path. */
  file: string;
  why: "name" | "installed";
}

export type NodeIslandMark = NodeIslandPathMark | NodeIslandPackageMark;

export interface NodeIslandPolicy {
  mode: NodeIslandsMode;
  /** Where the mode came from (an explicit `"auto": false` reads as
   * "explicit"). */
  modeSource: DecisionSource | "default";
  forcedNode: Map<string, DecisionSource>;
  forcedNative: Map<string, DecisionSource>;
  /** The command line's package marks by package name, each with how its
   * value was read. A mark stays here when `--native` overrides it, so the
   * build can refuse the pair instead of dropping the mark. */
  packageMarks: Map<string, NodeIslandPackageMark>;
  /** `"unloaded"` packages: never loaded, never islands. */
  unloaded: Set<string>;
  userModules: UserModulePattern[];
  node: string | null;
  strictUserJs: boolean;
}

/** Whether a `--node-island` value is a path by its spelling alone: it
 * starts with `.` (`./`, `../`, a dot file; no package name starts with a
 * dot), it is absolute, or it is a glob. Every other value is a bare
 * spelling, which `readNodeIslandMark` reads by what exists. */
export function isModuleIslandArgument(value: string): boolean {
  return value.startsWith(".") || isAbsolute(value) || value.includes("*");
}

/** Whether Node's lookup from `fromFile` finds a package directory named
 * `name`: a `node_modules/<name>/package.json` beside the file or above it,
 * where the program's own `import "<name>"` looks. */
function resolvesPackage(fromFile: string, name: string): boolean {
  for (let dir = dirname(resolve(fromFile)); ;) {
    if (trackedFileExists(join(dir, "node_modules", name, "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Reads one `--node-island` value for the program whose entry module is
 * `entry`. The spelling of a package name decides nothing: `highlight.js`,
 * `socket.io` and `@scope/data.json` are package names, and `lib/legacy` is
 * a file when that file exists. In order:
 *
 *  1. a value spelled as a path (`isModuleIslandArgument`) is a path or glob
 *     over the program's own modules, resolved from the working directory;
 *  2. a bare value whose first segment is `node_modules` is a path too: no
 *     package has that name;
 *  3. a bare value that names no existing file is a package name (with a
 *     subpath, the package the subpath belongs to);
 *  4. a bare value that names an existing file is that file, unless the
 *     entry module also resolves a package of that name: then it is the
 *     package, and `./<value>` spells the file.
 *
 * Paths resolve from `cwd`, the working directory. */
export function readNodeIslandMark(
  value: string,
  entry: string,
  cwd: string = process.cwd(),
): NodeIslandMark {
  const pattern = resolve(cwd, value);
  if (isModuleIslandArgument(value))
    return { kind: "path", value, pattern, why: value.includes("*") ? "glob" : "explicit" };
  const name = packageNameOfSpecifier(value);
  if (name === "node_modules") return { kind: "path", value, pattern, why: "node-modules" };
  if (!trackedFileExists(pattern))
    return { kind: "package", value, name, file: pattern, why: "name" };
  if (resolvesPackage(entry, name))
    return { kind: "package", value, name, file: pattern, why: "installed" };
  return { kind: "path", value, pattern, why: "file" };
}

/** The policy of the program whose entry module is `entry`: the project's
 * configuration with the command line's options over it. The entry decides
 * how a bare `--node-island` value reads (`readNodeIslandMark`). */
export function nodeIslandPolicy(
  config: ProjectConfig,
  given: NodeIslandOptions | undefined,
  entry: string,
): NodeIslandPolicy {
  const options = given ?? {};
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
  const packageMarks = new Map<string, NodeIslandPackageMark>();
  for (const value of options.islands ?? []) {
    const mark = readNodeIslandMark(value, entry);
    if (mark.kind === "path") {
      userModules.push({ pattern: mark.pattern, source: "cli", mark });
    } else {
      forcedNative.delete(mark.name);
      forcedNode.set(mark.name, "cli");
      if (!packageMarks.has(mark.name)) packageMarks.set(mark.name, mark);
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
    packageMarks,
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
