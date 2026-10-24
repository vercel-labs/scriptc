/* The project configuration: the `scriptc` key of the entry's nearest
 * package.json. One reader for every consumer (package shims, the
 * WebAssembly scanner, the Node island policy), with a schema: a value
 * this compiler does not know in `scriptc.packages` or
 * `scriptc.nodeIslands` is SC8004 instead of being ignored, because an
 * ignored setting is a silent divergence from what the project asked for.
 *
 *   "scriptc": {
 *     "packages": {
 *       "encoding": "unloaded",          // never loaded (package-shims.ts)
 *       "dd-trace": "node",              // run in a Node island
 *       "hot-shots": "native",           // must compile natively (SC8003)
 *       "proper-lockfile": { "run": "node", "evaluate": "lazy" }
 *     },
 *     "nodeIslands": { "auto": true, "modules": ["src/plugins/*.ts"] },
 *     "wasm": ["build/module.wasm"]
 *   }
 *
 * Node islands are report-only in this version: the policy decides which
 * packages and modules WOULD run in Node, and coverage reports it, but code
 * generation does not change. Other keys of the `scriptc` object are left
 * to their own readers. */
import { dirname, join, resolve } from "node:path";
import { projectConfigDiag, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { trackedReadFile } from "./frontend/input-tracker.js";

/** How a package runs: compiled natively, in a Node island, or decided by
 * the detector. */
export type PackageRun = "native" | "node" | "auto";
export type PackageEvaluate = "auto" | "lazy" | "eager";
export type PackageShare = "auto" | "shared" | "duplicate";
export type PackageMarshal = "copy" | "handles";
export type PackageSchedule = "lockstep" | "free";

/** One `scriptc.packages.<name>` entry. `unloaded` packages never load;
 * the other settings choose where the package runs. */
export interface PackageSetting {
  unloaded: boolean;
  run: PackageRun;
  evaluate: PackageEvaluate;
  share: PackageShare;
  marshal: PackageMarshal;
  schedule: PackageSchedule;
}

export interface NodeIslandsSetting {
  /** Automatic Node islands for npm code outside the native subset. */
  auto: boolean;
  /** User modules (paths or globs relative to the package.json) that run
   * in Node. */
  modules: string[];
  /** The `node` executable recorded into the binary. */
  node: string | null;
  /** A semver range checked at the helper handshake. */
  nodeVersion: string | null;
  packaging: "embedded" | "beside";
  speculativeStart: boolean;
}

export interface ProjectConfig {
  /** The package.json the configuration came from, or null. */
  manifest: string | null;
  /** Its text, for diagnostic code frames. */
  manifestText: string | null;
  packages: Map<string, PackageSetting>;
  nodeIslands: NodeIslandsSetting;
  /** `scriptc.wasm`: module paths, resolved against the manifest. */
  wasm: string[];
  /** SC8004 for every unknown key or value. */
  diagnostics: ScrDiagnostic[];
}

const PACKAGE_STRINGS = ["unloaded", "node", "native", "auto"];
const PACKAGE_OBJECT_KEYS: Record<string, string[]> = {
  run: ["native", "node", "auto"],
  evaluate: ["auto", "lazy", "eager"],
  share: ["auto", "shared", "duplicate"],
  marshal: ["copy", "handles"],
  schedule: ["lockstep", "free"],
};
const NODE_ISLANDS_KEYS = [
  "auto",
  "modules",
  "node",
  "nodeVersion",
  "packaging",
  "speculativeStart",
];

function defaultPackageSetting(): PackageSetting {
  return {
    unloaded: false,
    run: "auto",
    evaluate: "auto",
    share: "auto",
    marshal: "copy",
    schedule: "lockstep",
  };
}

function defaultNodeIslands(): NodeIslandsSetting {
  return {
    auto: true,
    modules: [],
    node: null,
    nodeVersion: null,
    packaging: "embedded",
    speculativeStart: false,
  };
}

/** The empty configuration of a project without a package.json. */
export function emptyProjectConfig(): ProjectConfig {
  return {
    manifest: null,
    manifestText: null,
    packages: new Map<string, PackageSetting>(),
    nodeIslands: defaultNodeIslands(),
    wasm: [],
    diagnostics: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function quoted(values: string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

/** A short rendering of a JSON value for a message. */
function shown(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}

/** Reads and validates one package.json text. Exported for tests. */
export function parseProjectConfig(manifest: string, text: string): ProjectConfig {
  const config = emptyProjectConfig();
  config.manifest = manifest;
  config.manifestText = text;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Node reports a malformed package.json itself; the configuration is
    // simply absent here, as before.
    return config;
  }
  if (!isRecord(parsed)) return config;
  const root = parsed["scriptc"];
  if (!isRecord(root)) return config;
  const locate = new JsonLocator(text);
  const problem = (path: string[], detail: string, hint: string): void => {
    config.diagnostics.push(
      projectConfigDiag(`scriptc.${path.join(".")}`, detail, hint, {
        file: manifest,
        start: locate.offsetOf(["scriptc", ...path]),
        end: locate.offsetOf(["scriptc", ...path]),
      }),
    );
  };

  const packages = root["packages"];
  if (packages !== undefined) {
    if (!isRecord(packages)) {
      problem(
        ["packages"],
        `must be an object mapping package names to settings, not ${shown(packages)}`,
        `write "packages": { "<name>": "auto" }`,
      );
    } else {
      for (const name of Object.keys(packages)) {
        const value = packages[name];
        const setting = defaultPackageSetting();
        if (typeof value === "string") {
          if (!PACKAGE_STRINGS.includes(value)) {
            problem(
              ["packages", name],
              `has the unknown value ${shown(value)}`,
              `use one of ${quoted(PACKAGE_STRINGS)}, or an object with ${Object.keys(PACKAGE_OBJECT_KEYS).join(", ")}`,
            );
            continue;
          }
          if (value === "unloaded") setting.unloaded = true;
          else setting.run = value as PackageRun;
          config.packages.set(name, setting);
          continue;
        }
        if (!isRecord(value)) {
          problem(
            ["packages", name],
            `must be a string or an object, not ${shown(value)}`,
            `use one of ${quoted(PACKAGE_STRINGS)}, or an object with ${Object.keys(PACKAGE_OBJECT_KEYS).join(", ")}`,
          );
          continue;
        }
        let valid = true;
        for (const key of Object.keys(value)) {
          const allowed = Object.hasOwn(PACKAGE_OBJECT_KEYS, key)
            ? PACKAGE_OBJECT_KEYS[key]
            : undefined;
          if (allowed === undefined) {
            problem(
              ["packages", name, key],
              "is not a known package setting",
              `the settings are ${Object.keys(PACKAGE_OBJECT_KEYS).join(", ")}`,
            );
            valid = false;
            continue;
          }
          const v = value[key];
          if (typeof v !== "string" || !allowed.includes(v)) {
            problem(
              ["packages", name, key],
              `has the unknown value ${shown(v)}`,
              `use one of ${quoted(allowed)}`,
            );
            valid = false;
            continue;
          }
          if (key === "run") setting.run = v as PackageRun;
          else if (key === "evaluate") setting.evaluate = v as PackageEvaluate;
          else if (key === "share") setting.share = v as PackageShare;
          else if (key === "marshal") setting.marshal = v as PackageMarshal;
          else setting.schedule = v as PackageSchedule;
        }
        if (valid) config.packages.set(name, setting);
      }
    }
  }

  const islands = root["nodeIslands"];
  if (islands !== undefined) {
    if (!isRecord(islands)) {
      problem(
        ["nodeIslands"],
        `must be an object, not ${shown(islands)}`,
        `write "nodeIslands": { "auto": true }`,
      );
    } else {
      const setting = config.nodeIslands;
      for (const key of Object.keys(islands)) {
        const v = islands[key];
        if (!NODE_ISLANDS_KEYS.includes(key)) {
          problem(
            ["nodeIslands", key],
            "is not a known Node island setting",
            `the settings are ${NODE_ISLANDS_KEYS.join(", ")}`,
          );
        } else if (key === "auto" || key === "speculativeStart") {
          if (typeof v !== "boolean") {
            problem(
              ["nodeIslands", key],
              `must be true or false, not ${shown(v)}`,
              "use a boolean",
            );
          } else if (key === "auto") setting.auto = v;
          else setting.speculativeStart = v;
        } else if (key === "modules") {
          const list: string[] = [];
          let ok = Array.isArray(v);
          if (Array.isArray(v)) {
            for (const entry of v as unknown[]) {
              if (typeof entry === "string" && entry !== "") list.push(entry);
              else ok = false;
            }
          }
          if (!ok) {
            problem(
              ["nodeIslands", key],
              `must be an array of module paths or globs, not ${shown(v)}`,
              `write "modules": ["src/plugins/loader.ts"]`,
            );
          } else setting.modules = list;
        } else if (key === "packaging") {
          if (v !== "embedded" && v !== "beside") {
            problem(
              ["nodeIslands", key],
              `has the unknown value ${shown(v)}`,
              `use "embedded" or "beside"`,
            );
          } else setting.packaging = v;
        } else if (typeof v !== "string" || v === "") {
          problem(
            ["nodeIslands", key],
            `must be a non-empty string, not ${shown(v)}`,
            key === "node"
              ? "give the path of the node executable"
              : `write a range such as ">=24.13.1"`,
          );
        } else if (key === "node") setting.node = v;
        else setting.nodeVersion = v;
      }
    }
  }

  // `scriptc.wasm` keeps its lenient reading: string entries of an array.
  const wasm = root["wasm"];
  if (Array.isArray(wasm)) {
    for (const entry of wasm as unknown[]) {
      if (typeof entry === "string") config.wasm.push(resolve(dirname(manifest), entry));
    }
  }
  return config;
}

let cachedManifest: string | null = null;
let cachedText: string | null = null;
let cachedConfig: ProjectConfig | null = null;

/** The configuration of the entry's nearest package.json (the first one
 * found walking up from the entry's directory, readable or not). */
export function readProjectConfig(entryPath: string): ProjectConfig {
  for (let dir = dirname(resolve(entryPath)); ;) {
    const manifest = join(dir, "package.json");
    const text = trackedReadFile(manifest);
    if (text !== null) {
      if (cachedConfig !== null && cachedManifest === manifest && cachedText === text)
        return cachedConfig;
      const config = parseProjectConfig(manifest, text);
      cachedManifest = manifest;
      cachedText = text;
      cachedConfig = config;
      return config;
    }
    const parent = dirname(dir);
    if (parent === dir) return emptyProjectConfig();
    dir = parent;
  }
}

/** Offsets of keys in a JSON text, for diagnostic locations. It follows
 * object nesting so `["scriptc", "packages", "x"]` finds the key `"x"`
 * inside `scriptc.packages`, not an earlier `"x"` elsewhere. */
class JsonLocator {
  constructor(private readonly text: string) {}

  /** The offset of the last key of `path` that could be found (0 when
   * none). */
  offsetOf(path: string[]): number {
    let start = 0;
    let end = this.text.length;
    let found = 0;
    for (const key of path) {
      const at = this.keyIn(key, start, end);
      if (at < 0) break;
      found = at;
      // The key's value: from after the colon to the end of its object.
      const colon = this.text.indexOf(":", at);
      if (colon < 0) break;
      start = colon + 1;
      end = this.valueEnd(start, end);
    }
    return found;
  }

  /** A direct key of the object starting at or after `start`. */
  private keyIn(key: string, start: number, end: number): number {
    const text = this.text;
    let depth = 0;
    let i = start;
    while (i < end) {
      const ch = text.charCodeAt(i);
      if (ch === 34 /* " */) {
        const close = this.stringEnd(i);
        if (depth === 1 && text.slice(i + 1, close) === key) {
          let j = close + 1;
          while (j < end && /\s/.test(text.charAt(j))) j++;
          if (text.charAt(j) === ":") return i;
        }
        i = close + 1;
        continue;
      }
      if (ch === 123 /* { */ || ch === 91 /* [ */) depth++;
      else if (ch === 125 /* } */ || ch === 93 /* ] */) {
        depth--;
        if (depth <= 0) return -1;
      }
      i++;
    }
    return -1;
  }

  private stringEnd(open: number): number {
    const text = this.text;
    let i = open + 1;
    while (i < text.length) {
      const ch = text.charCodeAt(i);
      if (ch === 92 /* \ */) i += 2;
      else if (ch === 34) return i;
      else i++;
    }
    return text.length;
  }

  /** The end of the JSON value that starts at or after `start`. */
  private valueEnd(start: number, end: number): number {
    const text = this.text;
    let i = start;
    while (i < end && /\s/.test(text.charAt(i))) i++;
    let depth = 0;
    while (i < end) {
      const ch = text.charCodeAt(i);
      if (ch === 34) {
        i = this.stringEnd(i) + 1;
        if (depth === 0) return i;
        continue;
      }
      if (ch === 123 || ch === 91) depth++;
      else if (ch === 125 || ch === 93) {
        depth--;
        if (depth <= 0) return i + 1;
      } else if (depth === 0 && ch === 44 /* , */) return i;
      i++;
    }
    return end;
  }
}
