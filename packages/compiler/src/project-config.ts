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
 *       "proper-lockfile": { "run": "node", "evaluate": "lazy" },
 *       "zod": { "shapes": false }       // no shape-inference overlay
 *     },
 *     "nodeIslands": { "auto": true, "modules": ["src/plugins/*.ts"] },
 *     "wasm": ["build/module.wasm"],
 *     "typePatches": {                   // frontend/type-patches/layer.ts
 *       "commander@^15.0.0": {
 *         "declarations": { "HelpContext.helpWidth": "| undefined" }
 *       }
 *     }
 *   }
 *
 * Node islands are report-only in this version: the policy decides which
 * packages and modules WOULD run in Node, and coverage reports it, but code
 * generation does not change. Other keys of the `scriptc` object are left
 * to their own readers. */
import { dirname, join, resolve } from "node:path";
import { projectConfigDiag, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { trackedFileExists, trackedReadFile } from "./frontend/input-tracker.js";
import { parseSelector, parseTypeText } from "./frontend/type-patches/selector.js";
import { isValidRange } from "./frontend/type-patches/semver.js";

/** How a package runs: compiled natively, in a Node island, or decided by
 * the detector. */
export type PackageRun = "native" | "node" | "auto";
export type PackageEvaluate = "auto" | "lazy" | "eager";
export type PackageShare = "auto" | "shared" | "duplicate";
export type PackageMarshal = "copy" | "handles";
export type PackageSchedule = "lockstep" | "free";

/** One `scriptc.packages.<name>` entry. `unloaded` packages never load;
 * `shapes: false` compiles the package without shape inference's typed
 * overlay (shape-inference/overlay.ts); the other settings choose where the
 * package runs. */
export interface PackageSetting {
  unloaded: boolean;
  shapes: boolean;
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

/** One declaration patch: a selector and the type text it maps to. */
export interface TypePatchDeclaration {
  selector: string;
  type: string;
  /** Offset of the selector key in the manifest, for diagnostics. */
  offset: number;
}

/** One `scriptc.typePatches["<package>@<range>"]` entry. */
export interface TypePatchEntry {
  /** The key as written. */
  key: string;
  pkg: string;
  range: string;
  declarations: TypePatchDeclaration[];
  /** `files`: declaration files of the package (or of its `@types/` twin,
   * written `@types/<name>/<path>`) replaced by local files, by
   * package-relative path. The local paths are absolute. */
  files: Map<string, string>;
  /** `types`: a local declaration file that becomes the package's
   * declaration entry (absolute), or null. */
  types: string | null;
  /** Offset of the key in the manifest. */
  offset: number;
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
  /** `scriptc.typePatches`, in manifest order. */
  typePatches: TypePatchEntry[];
  /** The local files the configuration checked for existence, with the
   * answer. A configuration read again from an unchanged package.json is
   * reused only while every answer still holds. */
  localFiles: { path: string; exists: boolean }[];
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
/** Every key of a package setting object: the string-valued ones above and
 * the boolean `shapes`. */
const PACKAGE_SETTING_KEYS = [...Object.keys(PACKAGE_OBJECT_KEYS), "shapes"];
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
    shapes: true,
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
    typePatches: [],
    localFiles: [],
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
              `use one of ${quoted(PACKAGE_STRINGS)}, or an object with ${PACKAGE_SETTING_KEYS.join(", ")}`,
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
            `use one of ${quoted(PACKAGE_STRINGS)}, or an object with ${PACKAGE_SETTING_KEYS.join(", ")}`,
          );
          continue;
        }
        let valid = true;
        for (const key of Object.keys(value)) {
          if (key === "shapes") {
            const v = value[key];
            if (typeof v !== "boolean") {
              problem(
                ["packages", name, key],
                `must be true or false, not ${shown(v)}`,
                "use a boolean",
              );
              valid = false;
            } else setting.shapes = v;
            continue;
          }
          const allowed = Object.hasOwn(PACKAGE_OBJECT_KEYS, key)
            ? PACKAGE_OBJECT_KEYS[key]
            : undefined;
          if (allowed === undefined) {
            problem(
              ["packages", name, key],
              "is not a known package setting",
              `the settings are ${PACKAGE_SETTING_KEYS.join(", ")}`,
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

  const patches = root["typePatches"];
  if (patches !== undefined) readTypePatches(patches, config, problem, locate);

  // `scriptc.wasm` keeps its lenient reading: string entries of an array.
  const wasm = root["wasm"];
  if (Array.isArray(wasm)) {
    for (const entry of wasm as unknown[]) {
      if (typeof entry === "string") config.wasm.push(resolve(dirname(manifest), entry));
    }
  }
  return config;
}

const TYPE_PATCH_KEYS = ["declarations", "files", "types", "note"];
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
/** Packages whose declarations ship with scriptc or TypeScript: a wrong
 * one is a bug to report, not a project-local patch. */
const UNPATCHABLE = /^(?:@types\/node|typescript|@typescript\/.*)$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/** Reads and validates `scriptc.typePatches`. */
function readTypePatches(
  patches: unknown,
  config: ProjectConfig,
  problem: (path: string[], detail: string, hint: string) => void,
  locate: JsonLocator,
): void {
  if (!isRecord(patches)) {
    problem(
      ["typePatches"],
      `must be an object mapping "<package>@<range>" to patches, not ${shown(patches)}`,
      `write "typePatches": { "<package>@^1.0.0": { "declarations": { "Type.member": "| undefined" } } }`,
    );
    return;
  }
  for (const key of Object.keys(patches)) {
    const at = key.lastIndexOf("@");
    const pkg = at > 0 ? key.slice(0, at) : key;
    const range = at > 0 ? key.slice(at + 1).trim() : "";
    if (at <= 0 || range === "" || !PACKAGE_NAME.test(pkg)) {
      problem(
        ["typePatches", key],
        "must name a package and a version range",
        `write "${at > 0 ? pkg : key}@^1.0.0": the range says which installed versions the patch describes`,
      );
      continue;
    }
    if (!isValidRange(range)) {
      problem(
        ["typePatches", key],
        `has the version range "${range}", which is not a semver range`,
        `use a range such as "^${/^\d/.test(range) ? range.replace(/[^\d.]/g, "") : "1.0.0"}" or "1.2.x"`,
      );
      continue;
    }
    if (UNPATCHABLE.test(pkg)) {
      problem(
        ["typePatches", key],
        `patches ${pkg}, whose declarations ship with scriptc or TypeScript`,
        "report a wrong declaration there instead of patching it",
      );
      continue;
    }
    const value = patches[key];
    if (!isRecord(value)) {
      problem(
        ["typePatches", key],
        `must be an object, not ${shown(value)}`,
        `write { "declarations": { "Type.member": "| undefined" } }`,
      );
      continue;
    }
    const entry: TypePatchEntry = {
      key,
      pkg,
      range,
      declarations: [],
      files: new Map(),
      types: null,
      offset: locate.offsetOf(["scriptc", "typePatches", key]),
    };
    const base = dirname(config.manifest!);
    const localFile = (path: string[], v: unknown): string | null => {
      if (typeof v !== "string" || v === "") {
        problem(
          path,
          `must be the path of a local declaration file, not ${shown(v)}`,
          `write "./type-patches/${pkg}.d.ts"`,
        );
        return null;
      }
      const abs = resolve(base, v);
      if (!DECLARATION_FILE.test(abs)) {
        problem(
          path,
          `names "${v}", which is not a declaration file`,
          "use a .d.ts, .d.mts or .d.cts file",
        );
        return null;
      }
      const exists = trackedFileExists(abs);
      config.localFiles.push({ path: abs, exists });
      if (!exists) {
        problem(
          path,
          `names "${v}", which does not exist`,
          "give the path relative to this package.json",
        );
        return null;
      }
      return abs;
    };
    const files = value["files"];
    if (files !== undefined && !isRecord(files)) {
      problem(
        ["typePatches", key, "files"],
        `must be an object mapping declaration files of the package to local files, not ${shown(files)}`,
        `write "files": { "dist/index.d.ts": "./type-patches/${pkg}.d.ts" }`,
      );
    } else if (files !== undefined) {
      for (const target of Object.keys(files)) {
        const path = ["typePatches", key, "files", target];
        const rel = target.replace(/^\.\//, "");
        if (!DECLARATION_FILE.test(rel) || rel.startsWith("/") || rel.split("/").includes("..")) {
          problem(
            path,
            "must name a declaration file inside the package",
            `write a package-relative .d.ts path such as "dist/index.d.ts", or "@types/<name>/index.d.ts" for its @types package`,
          );
          continue;
        }
        const abs = localFile(path, files[target]);
        if (abs !== null) entry.files.set(rel, abs);
      }
    }
    if (value["types"] !== undefined)
      entry.types = localFile(["typePatches", key, "types"], value["types"]);
    let valid = true;
    for (const k of Object.keys(value)) {
      if (!TYPE_PATCH_KEYS.includes(k)) {
        problem(
          ["typePatches", key, k],
          "is not a known type patch setting",
          `the settings are ${TYPE_PATCH_KEYS.join(", ")}`,
        );
        valid = false;
      }
    }
    const note = value["note"];
    if (note !== undefined && typeof note !== "string") {
      problem(
        ["typePatches", key, "note"],
        `must be a string, not ${shown(note)}`,
        "write a short note, such as a link to the upstream issue",
      );
      valid = false;
    }
    const decls = value["declarations"];
    if (decls !== undefined && !isRecord(decls)) {
      problem(
        ["typePatches", key, "declarations"],
        `must be an object mapping selectors to types, not ${shown(decls)}`,
        `write "declarations": { "Type.member": "| undefined" }`,
      );
      valid = false;
    } else if (decls !== undefined) {
      for (const selector of Object.keys(decls)) {
        const path = ["typePatches", key, "declarations", selector];
        const parsed = parseSelector(selector);
        if ("error" in parsed) {
          problem(
            path,
            `is not a selector: it ${parsed.error}`,
            `name a declaration such as "Type.member", "fn()", "fn(param)", "file.js:local()" or "export=()"`,
          );
          continue;
        }
        const type = decls[selector];
        if (typeof type !== "string") {
          problem(
            path,
            `must map to a type string, not ${shown(type)}`,
            `write "| undefined" to widen, or the whole type to replace it`,
          );
          continue;
        }
        const op = parseTypeText(type);
        if ("error" in op) {
          problem(
            path,
            `has a type that ${op.error}`,
            `write "| undefined" to widen, or the whole type on one line`,
          );
          continue;
        }
        entry.declarations.push({ selector, type, offset: locate.offsetOf(["scriptc", ...path]) });
      }
    }
    if (valid) config.typePatches.push(entry);
  }
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
      if (
        cachedConfig !== null &&
        cachedManifest === manifest &&
        cachedText === text &&
        cachedConfig.localFiles.every((file) => trackedFileExists(file.path) === file.exists)
      )
        return cachedConfig;
      // A manifest without a `scriptc` key (none spelled out, none behind a
      // \u escape) has the empty configuration; builds of such projects
      // skip parsing and validating it.
      const config =
        text.includes("scriptc") || text.includes("\\u")
          ? parseProjectConfig(manifest, text)
          : { ...emptyProjectConfig(), manifest, manifestText: text };
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
