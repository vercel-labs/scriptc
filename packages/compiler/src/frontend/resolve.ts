/* scriptc's OWN module resolver — the bounded reimplementation of the three
 * ts.resolve* entry points the program lifecycle leans on, for the TS7 world
 * (typescript@7.0.2 ships no client-side resolution API at all). Pure
 * strings and node:fs — no AST, checker, or enum objects from either
 * TypeScript world cross this module, so both lanes may share it.
 *
 * The contract is PARITY with typescript@5.9.3's answers under scriptc's
 * fixed resolution options (moduleResolution bundler, allowJs, checkJs,
 * resolveJsonModule, allowImportingTsExtensions — program.ts's
 * COMPILER_OPTIONS): candidate lists below are transcribed from probed
 * failedLookupLocations of ts.resolveModuleName / the resolved answers on
 * the fixture tree, and the resolver parity suite (test/ts7/resolver-
 * parity.test.ts) sweeps every specifier of the whole corpus through BOTH
 * implementations and requires identical answers. Change 5.9.3's options
 * and these tables are wrong — that is what the suite is for. */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { isNpmStaticPackage, npmStaticPackageOfPath, npmStaticTransformPkgJson } from "./npm-static.js";
import { provenanceEntryFor } from "./provenance-registry.js";
import { trackedAccessibleEntries, trackedDirectoryExists, trackedExists, trackedFileExists, trackedReadFile, trackedRealpath } from "./input-tracker.js";

function isFile(path: string): boolean {
  return trackedFileExists(path);
}

function isDirectory(path: string): boolean {
  return trackedDirectoryExists(path);
}

function realpathOr(path: string): string {
  return trackedRealpath(path) ?? path;
}

interface PkgJson {
  name?: string;
  version?: string;
  type?: string;
  types?: string;
  typings?: string;
  main?: string;
  exports?: unknown;
  /** The workspace ROOT's member declaration: an array of directory globs
   * (or `{ packages: [...] }` — the tool-config twin of the same field). */
  workspaces?: unknown;
}

const pkgJsonCache = new Map<string, PkgJson | null>();

function pkgJsonOf(dir: string): PkgJson | null {
  let cached = pkgJsonCache.get(dir);
  if (cached === undefined) {
    const path = join(dir, "package.json");
    let parsed: PkgJson | null = null;
    if (trackedExists(path)) {
      try {
        parsed = JSON.parse(trackedReadFile(path)!) as PkgJson;
      } catch {
        parsed = null;
      }
    }
    cached = parsed;
    pkgJsonCache.set(dir, cached);
  }
  return cached;
}

/* ── workspace member declarations ───────────────────────────────────────
 *
 * Most workspace installs LINK internal packages into node_modules, so a
 * resolved answer's realpath escapes node_modules and withWorkspace (below)
 * classifies it from the link alone. Workspace trees that COPY instead of
 * symlink leave the realpath inside node_modules — but the tree still
 * declares its members: the workspace ROOT's package.json "workspaces"
 * globs. These helpers answer the declared member directory for a package
 * NAME, so a copied install classifies workspace-linked exactly like a
 * symlinked one. */

/** The "workspaces" patterns of a package.json — the array form or the
 * `{ packages: [...] }` object twin. Null when absent/malformed. */
function workspacePatternsOf(pkg: PkgJson | null): string[] | null {
  const raw =
    pkg === null
      ? undefined
      : Array.isArray(pkg.workspaces)
        ? pkg.workspaces
        : typeof pkg.workspaces === "object" && pkg.workspaces !== null
          ? (pkg.workspaces as { packages?: unknown }).packages
          : undefined;
  if (!Array.isArray(raw)) return null;
  const patterns = raw.filter((p): p is string => typeof p === "string" && !p.startsWith("!"));
  return patterns.length > 0 ? patterns : null;
}

/** Expands one workspaces glob under `root` to existing directories.
 * Segment-wise: `*` expands one directory level, everything else is
 * literal — the "packages/*" convention (a trailing "/" is tolerated;
 * node_modules never enumerates). Directories only. */
function expandWorkspacePattern(root: string, pattern: string): string[] {
  let dirs = [root];
  for (const seg of pattern.split("/")) {
    if (seg === "" || seg === ".") continue;
    const next: string[] = [];
    for (const dir of dirs) {
      if (seg === "*") {
        const entries = trackedAccessibleEntries(dir)?.directories ?? [];
        for (const e of entries) {
          if (e === "node_modules" || e.startsWith(".")) continue;
          const child = join(dir, e);
          if (isDirectory(child)) next.push(child);
        }
      } else {
        const child = join(dir, seg);
        if (isDirectory(child)) next.push(child);
      }
    }
    dirs = next;
  }
  return dirs.filter((d) => d !== root);
}

/** Declared workspace members by package NAME under a workspaces-bearing
 * root — each glob-matched directory whose package.json carries a name.
 * Cached per root (one compile's view; clearResolveCaches resets). */
const workspaceMembersCache = new Map<string, Map<string, string>>();

function workspaceMembersOf(root: string, patterns: string[]): Map<string, string> {
  let members = workspaceMembersCache.get(root);
  if (members === undefined) {
    members = new Map();
    for (const pattern of patterns) {
      for (const dir of expandWorkspacePattern(root, pattern)) {
        const name = pkgJsonOf(dir)?.name;
        if (typeof name === "string" && name !== "" && !members.has(name)) members.set(name, dir);
      }
    }
    workspaceMembersCache.set(root, members);
  }
  return members;
}

/** The declared workspace-member directory for `packageName`, found by
 * walking UP from the directory holding the node_modules that answered —
 * the nearest workspaces-bearing package.json decides (workspace roots
 * don't nest; a root whose globs don't name the package answers null).
 * Realpath'd like the symlink classification stamps. */
function workspaceMemberDirOf(fromDir: string, packageName: string): string | null {
  for (let dir = fromDir; ; ) {
    const patterns = workspacePatternsOf(pkgJsonOf(dir));
    if (patterns !== null) {
      const member = workspaceMembersOf(dir, patterns).get(packageName);
      return member !== undefined ? realpathOr(member) : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/* ── relative specifiers ─────────────────────────────────────────────────
 *
 * Probed 5.9.3 bundler candidate orders (failedLookupLocations, exhaustive
 * for each specifier shape; "stem" is the specifier minus its extension):
 *   ./x       → x.ts x.tsx x.d.ts x.js x.jsx, then directory
 *   ./x.js    → stem+[.ts .tsx .d.ts .js .jsx], x.js+[.ts .tsx .d.ts .js
 *               .jsx], then directory   (.ts and .tsx specifiers identical:
 *               the exact name sits in the first group)
 *   ./x.jsx   → stem+[.tsx .ts .d.ts .jsx .js], then as above
 *   ./x.mjs   → stem+[.mts .d.mts .mjs], full-name group, directory
 *   ./x.cjs   → stem+[.cts .d.cts .cjs], full-name group, directory
 *   ./x.json  → stem+.d.json.ts, x.json, full-name group, directory
 * Directory: package.json probed (types/typings, then main, each resolved
 * like a relative FILE), then index.[ts tsx d.ts js jsx]. */

const TS_FIRST = [".ts", ".tsx", ".d.ts", ".js", ".jsx"];
const TSX_FIRST = [".tsx", ".ts", ".d.ts", ".jsx", ".js"];

/** The extension-substitution group for a specifier, or null when the
 * specifier's extension is unrecognized (full-name candidates only). */
function substitutionCandidates(base: string): string[] {
  const stemOf = (ext: string): string => base.slice(0, -ext.length);
  for (const ext of [".ts", ".js"]) {
    if (base.endsWith(ext)) return TS_FIRST.map((e) => stemOf(ext) + e);
  }
  for (const ext of [".tsx", ".jsx"]) {
    if (base.endsWith(ext)) return TSX_FIRST.map((e) => stemOf(ext) + e);
  }
  if (base.endsWith(".mts") || base.endsWith(".mjs")) {
    const stem = stemOf(".mjs");
    return [stem + ".mts", stem + ".d.mts", stem + ".mjs"];
  }
  if (base.endsWith(".cts") || base.endsWith(".cjs")) {
    const stem = stemOf(".cjs");
    return [stem + ".cts", stem + ".d.cts", stem + ".cjs"];
  }
  if (base.endsWith(".json")) {
    return [stemOf(".json") + ".d.json.ts", base];
  }
  return [];
}

/** Loads `base` as a FILE with 5.9.3's bundler candidate order: the
 * extension-substitution group when the extension is recognized, then the
 * full name with every extension appended. */
function loadAsFile(base: string): string | null {
  for (const candidate of substitutionCandidates(base)) {
    if (isFile(candidate)) return candidate;
  }
  for (const ext of TS_FIRST) {
    if (isFile(base + ext)) return base + ext;
  }
  return null;
}

/** Loads `base` as a DIRECTORY: package.json types/typings then main (each
 * like a relative file), then the index files. */
function loadAsDirectory(base: string): string | null {
  if (!isDirectory(base)) return null;
  const pkg = pkgJsonOf(base);
  if (pkg) {
    for (const field of [pkg.types, pkg.typings, pkg.main]) {
      if (typeof field === "string" && field !== "") {
        const target = join(base, field);
        const viaFile = loadAsFile(target) ?? (isFile(target) ? target : null);
        if (viaFile) return viaFile;
      }
    }
  }
  for (const ext of TS_FIRST) {
    const idx = join(base, "index" + ext);
    if (isFile(idx)) return idx;
  }
  return null;
}

/** The RUNTIME sibling of a PROJECT declaration twin — "src/index.js" for
 * "src/index.d.ts" when both exist OUTSIDE node_modules — or null. Node
 * loads the JS (declaration files do not exist in its world), and a
 * project module's implementation is what scriptc compiles: a hand-kept
 * .d.ts beside runtime JS (the classic typed-JS-library entry, the classic
 * typed-JS-library pattern) is the author's claim about the code, not
 * the code. EXACTLY the .d.ts/.js pair: the per-format spellings
 * (.d.mts/.d.cts twins — an openh264.d.mts beside its island-bound
 * wasm loader, the npm fixtures' shape.d.mts) are the established
 * scriptc idiom for declaring a typed surface over JS that deliberately
 * runs in the island, and stay authoritative. npm packages keep the npm
 * story (their declarations ARE the consumer surface; --npm-static opts
 * into the JS per package), and a declaration with NO runtime sibling
 * stays a type-only module exactly as before. The tsgo host hides the
 * same twins (loadProgram's composed fsShadow), so both resolution
 * worlds answer the JS.
 *
 * "PROJECT" means the entry's own package realm: a workspace-linked
 * package's realpaths carry no node_modules segment either, but its
 * declarations ARE the consumer surface (the npm story), so twins hide
 * only under the same package.json as the entry. */
let projectRealmPkgJson: string | null = null;

export function setProjectRealm(entryPath: string): void {
  projectRealmPkgJson = nearestPkgJsonPath(entryPath);
}

export function projectDtsRuntimeSibling(path: string): string | null {
  if (path.includes("/node_modules/") || path.includes("\\node_modules\\")) return null;
  if (!path.endsWith(".d.ts")) return null;
  if (projectRealmPkgJson === null || nearestPkgJsonPath(path) !== projectRealmPkgJson) return null;
  const sibling = path.slice(0, -".d.ts".length) + ".js";
  return isFile(sibling) ? sibling : null;
}

/** Resolves a RELATIVE import specifier from `fromFile` the way 5.9.3's
 * ts.resolveModuleName does under scriptc's options. Returns the resolved
 * absolute path (not realpath'd — matching 5.9.3, which keeps in-project
 * paths as spelled), or null. */
export function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(resolve(fromFile)), specifier);
  // Inside an opted-in --npm-static package, relative edges resolve to the
  // shipped JS, never to a sibling declaration twin: the .d.ts is the
  // claim, the JS is the code that compiles (npm-static.ts — the tsgo
  // host hides the same files, so both worlds answer the JS).
  if (npmStaticPackageOfPath(resolve(fromFile)) !== null) {
    return loadAsJsFile(base) ?? loadAsJsDirectory(base);
  }
  const answer = loadAsFile(base) ?? loadAsDirectory(base);
  // A project declaration TWIN answers its runtime sibling (see
  // projectDtsRuntimeSibling — Node's truth for project code).
  if (answer !== null) {
    const sibling = projectDtsRuntimeSibling(answer);
    if (sibling !== null) return sibling;
  }
  return answer;
}

/** The JS-only twin of loadAsFile for --npm-static package internals:
 * exact file first (JS/JSON only), then Node's extension candidates —
 * declaration files never answer. */
function loadAsJsFile(base: string): string | null {
  if (/\.(js|mjs|cjs|jsx|json)$/.test(base) && isFile(base)) return base;
  for (const ext of [".js", ".json", ".mjs", ".cjs"]) {
    if (isFile(base + ext)) return base + ext;
  }
  return null;
}

/** The JS-only twin of loadAsDirectory: package.json "main" (types/typings
 * deliberately skipped), then the JS index files. */
function loadAsJsDirectory(base: string): string | null {
  if (!isDirectory(base)) return null;
  const pkg = pkgJsonOf(base);
  if (pkg && typeof pkg.main === "string" && pkg.main !== "") {
    const viaFile = loadAsJsFile(join(base, pkg.main));
    if (viaFile) return viaFile;
  }
  for (const ext of [".js", ".json", ".mjs", ".cjs"]) {
    const idx = join(base, "index" + ext);
    if (isFile(idx)) return idx;
  }
  return null;
}

/* ── bare specifiers (npm types) ─────────────────────────────────────────
 *
 * Probed 5.9.3 order per node_modules directory walking up from the
 * importer: the package directory (exports map with the bundler condition
 * set {types, import, default} in object-key order; else types/typings/
 * main; else subpath as a file; else index), then node_modules/<spec> as a
 * bare FILE (.ts .tsx .d.ts), then the mangled @types package. JavaScript
 * is NEVER a candidate inside node_modules (probed: no .js/.jsx in any
 * failedLookupLocations there), so substitution maps .js targets to their
 * declaration twins only. */

/** The conditions 5.9.3's bundler resolution enables for import sites
 * (probed: "module"/"node"/"browser"/"bundler" keys are NOT matched). */
const EXPORT_CONDITIONS = new Set(["types", "import", "default"]);

/** The bundler condition set minus "types" — what an opted-in --npm-static
 * package resolves with (its declarations are hidden from resolution; the
 * runtime JS is the compile target). Mirrors the types-stripped
 * package.json the tsgo host serves for the same package. */
const JS_ONLY_CONDITIONS = new Set(["import", "default"]);

/** package.json "exports" lookup: exact subpath keys, then '*' patterns
 * (longest literal prefix wins), condition objects in object-key order,
 * arrays first-resolvable. Returns the target path relative to the package
 * directory, or null. Mirrors npm.ts's runtime resolver with the TYPES
 * condition set. */
function resolveExportsTypes(
  exports: unknown,
  subpath: string,
  conditions: ReadonlySet<string> = EXPORT_CONDITIONS,
): string | null {
  const resolveTarget = (target: unknown, wildcard: string | null): string | null => {
    if (typeof target === "string") {
      return wildcard === null ? target : target.split("*").join(wildcard);
    }
    if (Array.isArray(target)) {
      for (const t of target) {
        const r = resolveTarget(t, wildcard);
        if (r) return r;
      }
      return null;
    }
    if (target && typeof target === "object") {
      for (const [key, value] of Object.entries(target)) {
        if (key.startsWith(".")) continue;
        if (conditions.has(key)) {
          const r = resolveTarget(value, wildcard);
          if (r) return r;
        }
      }
    }
    return null;
  };
  if (typeof exports === "string" || Array.isArray(exports)) {
    return subpath === "." ? resolveTarget(exports, null) : null;
  }
  if (exports && typeof exports === "object") {
    const map = exports as Record<string, unknown>;
    const keys = Object.keys(map);
    if (!keys.every((k) => k.startsWith("."))) {
      return subpath === "." ? resolveTarget(exports, null) : null;
    }
    if (Object.prototype.hasOwnProperty.call(map, subpath)) {
      return resolveTarget(map[subpath], null);
    }
    let best: { key: string; prefix: string; suffix: string } | null = null;
    for (const key of keys) {
      const star = key.indexOf("*");
      if (star < 0) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (
        subpath.startsWith(prefix) &&
        subpath.length >= prefix.length + suffix.length &&
        subpath.endsWith(suffix) &&
        (!best || prefix.length > best.prefix.length)
      ) {
        best = { key, prefix, suffix };
      }
    }
    if (!best) return null;
    const wildcard = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
    return resolveTarget(map[best.key], wildcard);
  }
  return null;
}

/* ── project imports (package.json "imports" / self-name "exports") ─────
 *
 * The two package.json-mediated specifier families that resolve INSIDE the
 * project rather than into node_modules — Node's `#alias` imports field and
 * the self-name reference (a bare specifier naming the nearest package.json's
 * own "name", resolved through its "exports"). 5.9.3's bundler resolution
 * answers both (probed: `#cjs` → ./index.cjs → index.cts by extension
 * substitution; `pkg/sub/x.js` through a `./sub/*` exports pattern →
 * ./src/x.ts), with the SAME condition set and pattern rules as the
 * node_modules exports lookup — so the machinery is shared. Two Node rules
 * carry over verbatim: only the specifier exactly "#" is invalid ("#/..."
 * resolves through "#/*"-style pattern keys — probed on Node v24.15.0,
 * which the ERR_INVALID_MODULE_SPECIFIER carve-out no longer covers), and
 * self-name resolution requires the nearest package.json to carry BOTH a
 * matching "name" and an "exports" field (no exports → no self-reference;
 * the walk stops at the nearest package.json either way). An imports-field
 * TARGET that is not "./"-relative is Node's PACKAGE_RESOLVE re-entry (an
 * alias may name another package — including the package's own self-name):
 * the project half of that re-entry resolves here; bare targets naming
 * real node_modules packages stay other resolvers' business. */

/** The nearest directory at or above `dir` holding a package.json, or
 * null. Node's LOOKUP_PACKAGE_SCOPE, minus the node_modules stop (callers
 * hand in project files only). */
function nearestPkgDir(dir: string): string | null {
  let d = dir;
  for (;;) {
    if (pkgJsonOf(d)) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** The nearest package.json FILE, whether or not its JSON parses. Runtime
 * module-format lookup must stop at a malformed nearest scope: Node reports
 * ERR_INVALID_PACKAGE_CONFIG there rather than silently inheriting a parent
 * package's `type`. The resolver's historical nearestPkgDir stays parseable-
 * package-only because its callers need a package OBJECT to inspect. */
function nearestPackageConfigDir(dir: string): string | null {
  let d = dir;
  for (;;) {
    if (trackedExists(join(d, "package.json"))) return d;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** package.json "imports" lookup — the exports machinery over "#" keys
 * (exact keys, then '*' patterns, condition objects in key order). */
function resolveImportsField(imports: unknown, specifier: string): string | null {
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) return null;
  const map = imports as Record<string, unknown>;
  // Reuse the exports resolver by re-rooting the key space: "./" + the
  // specifier past "#" against keys with their "#" swapped for ".".
  const rekeyed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!k.startsWith("#")) continue;
    rekeyed["." + k.slice(1)] = v;
  }
  return resolveExportsTypes(rekeyed, "." + specifier.slice(1));
}

/** Absolute path of the nearest package.json at or above `fromFile`'s
 * directory — the package scope Node's imports-field refusals name
 * (ERR_PACKAGE_IMPORT_NOT_DEFINED carries it). Null outside any scope. */
export function nearestPkgJsonPath(fromFile: string): string | null {
  const dir = nearestPkgDir(dirname(resolve(fromFile)));
  return dir === null ? null : join(dir, "package.json");
}

/** The explicit module format of the nearest package scope. A package.json
 * without a recognized `type` keeps the file ambiguous, so callers may
 * apply Node's syntax detector; an explicit commonjs/module answer must win
 * over syntax detection for ordinary .js/.ts files. */
export function nearestPackageType(fromFile: string): "module" | "commonjs" | null {
  const dir = nearestPackageConfigDir(dirname(resolve(fromFile)));
  if (dir === null) return null;
  const type = pkgJsonOf(dir)?.type;
  return type === "module" || type === "commonjs" ? type : null;
}

/** The malformed nearest package scope Node would reject before loading
 * `fromFile`, or null when there is no package.json or it parses as an
 * object. Kept separate from nearestPackageType so an absent/typeless valid
 * package can still use syntax detection. */
export function nearestInvalidPackageJsonPath(fromFile: string): string | null {
  const dir = nearestPackageConfigDir(dirname(resolve(fromFile)));
  if (dir === null || pkgJsonOf(dir) !== null) return null;
  return join(dir, "package.json");
}

/** Resolves a PROJECT-INTERNAL package.json-mediated specifier from
 * `fromFile` — `#alias` (the imports field) or a self-name reference (the
 * nearest package.json's own name through its exports) — to an absolute
 * source path with the usual bundler extension substitution, or null.
 * Relative specifiers, real node_modules packages, and builtins are other
 * resolvers' business; callers try those first. */
export function resolveProjectImport(fromFile: string, specifier: string): string | null {
  // --provenance-sources (flag-gated; the registry is empty otherwise): a
  // registered bare specifier answers its attested SOURCE entry — the one
  // chokepoint that makes preflight's user-module edges, the module
  // order, and the CJS link check all agree the package compiles as
  // program modules instead of island-embedding its published dist.
  const provenance = provenanceEntryFor(specifier);
  if (provenance !== null) return provenance;
  const pkgDir = nearestPkgDir(dirname(resolve(fromFile)));
  if (pkgDir === null) return null;
  const pkg = pkgJsonOf(pkgDir) as (PkgJson & { imports?: unknown; exports?: unknown; type?: string }) | null;
  if (!pkg) return null;
  let target: string | null = null;
  if (specifier.startsWith("#")) {
    // Node's validity rule: only the bare "#" is never resolvable ("#/..."
    // matches "#/*"-pattern keys on current Node).
    if (specifier === "#") return null;
    target = resolveImportsField((pkg as { imports?: unknown }).imports, specifier);
    // An imports target that is not "./"-relative is PACKAGE_RESOLVE'd as
    // a bare specifier (Node's PACKAGE_IMPORTS_EXPORTS_RESOLVE): the
    // project-internal half of that re-entry is the self-name rule below —
    // recurse with the target as the specifier (from the same package
    // scope). Targets naming real node_modules packages answer null here;
    // callers' npm resolution owns those.
    if (target !== null && !target.startsWith("./") && !target.startsWith("#")) {
      return resolveProjectImport(join(pkgDir, "package.json"), target);
    }
  } else if (typeof pkg.name === "string" && pkg.name !== "" && pkg.exports !== undefined) {
    // Self-name: the specifier's package-name part must equal the nearest
    // package.json's name; the remainder is an exports subpath.
    const parts = specifier.split("/");
    const nameLen = specifier.startsWith("@") ? 2 : 1;
    const pkgName = parts.slice(0, nameLen).join("/");
    if (pkgName !== pkg.name || parts.length < nameLen) return null;
    const subpath = parts.length === nameLen ? "." : "./" + parts.slice(nameLen).join("/");
    target = resolveExportsTypes(pkg.exports, subpath);
  }
  if (target === null) return null;
  const path = join(pkgDir, target);
  return loadAsFile(path) ?? (isFile(path) ? path : null);
}

/* 5.9.3 with allowJs resolves node_modules in TWO FULL PASSES (probed): the
 * whole node_modules walk-up first admits only TypeScript/declaration
 * answers (a .js exports target or main maps to its .ts/.d.ts twins, JS
 * itself never matches, @types included), and only when that entire walk
 * fails does a second identical walk run admitting the JavaScript files
 * themselves. An untyped package with an @types twin therefore answers the
 * @types files; an untyped package without one answers its own .js. */
type NmPass = "types" | "js";

function extensionsFor(pass: NmPass, flavor: "plain" | "x" | "m" | "c"): string[] {
  if (pass === "types") {
    switch (flavor) {
      case "m": return [".mts", ".d.mts"];
      case "c": return [".cts", ".d.cts"];
      case "x": return [".tsx", ".ts", ".d.ts"];
      default: return [".ts", ".tsx", ".d.ts"];
    }
  }
  switch (flavor) {
    case "m": return [".mjs"];
    case "c": return [".cjs"];
    case "x": return [".jsx", ".js"];
    default: return [".js", ".jsx"];
  }
}

/** File resolution of an exports-map target (or types/typings/main field)
 * inside node_modules, for one pass: recognized-extension substitution,
 * extension addition, then directory index. */
function loadTargetInPass(pkgDir: string, target: string, pass: NmPass): string | null {
  const path = join(pkgDir, target);
  if (pass === "types") {
    if (/\.(d\.ts|d\.mts|d\.cts|ts|tsx|mts|cts)$/.test(path) && isFile(path)) return path;
  } else if (/\.(js|jsx|mjs|cjs)$/.test(path) && isFile(path)) {
    return path;
  }
  const sub = (ext: string, flavor: "plain" | "x" | "m" | "c"): string | null => {
    const stem = path.slice(0, -ext.length);
    for (const r of extensionsFor(pass, flavor)) {
      if (isFile(stem + r)) return stem + r;
    }
    return null;
  };
  if (path.endsWith(".mjs")) return sub(".mjs", "m");
  if (path.endsWith(".cjs")) return sub(".cjs", "c");
  if (path.endsWith(".js")) return sub(".js", "plain");
  if (path.endsWith(".jsx")) return sub(".jsx", "x");
  // No/unknown extension: extension addition, then a directory — a NESTED
  // package.json's types/typings/main first (probed: 5.9.3 resolves
  // "@restart/hooks/useMergedRefs" through the subdirectory's own
  // package.json, "module" ignored), then the index files.
  for (const ext of extensionsFor(pass, "plain")) {
    if (isFile(path + ext)) return path + ext;
  }
  if (isDirectory(path)) {
    const nested = pkgJsonOf(path);
    if (nested) {
      for (const field of [nested.types, nested.typings, nested.main]) {
        if (typeof field === "string" && field !== "") {
          const via = loadTargetInPass(path, field, pass);
          if (via) return via;
        }
      }
    }
    for (const ext of extensionsFor(pass, "plain")) {
      const idx = join(path, "index" + ext);
      if (isFile(idx)) return idx;
    }
  }
  return null;
}

/** node_modules file-or-directory resolution for a package-internal path (a
 * subpath without exports, the root lookup), for one pass. */
function loadPathInPass(pkgDir: string, rel: string, pass: NmPass): string | null {
  const base = rel === "." ? pkgDir : join(pkgDir, rel);
  if (rel !== ".") {
    const viaFile = loadTargetInPass(pkgDir, rel, pass);
    if (viaFile) return viaFile;
    return null;
  }
  if (!isDirectory(base)) return null;
  const pkg = pkgJsonOf(base);
  if (pkg) {
    for (const field of [pkg.types, pkg.typings]) {
      if (typeof field === "string" && field !== "") {
        const viaTypes = loadTargetInPass(base, field, pass);
        if (viaTypes) return viaTypes;
      }
    }
    if (typeof pkg.main === "string" && pkg.main !== "") {
      const viaMain = loadTargetInPass(base, pkg.main, pass);
      if (viaMain) return viaMain;
    }
  }
  for (const ext of extensionsFor(pass, "plain")) {
    const idx = join(base, "index" + ext);
    if (isFile(idx)) return idx;
  }
  return null;
}

export interface BareResolution {
  /** The resolved types file, realpath'd (5.9.3 resolves node_modules
   * symlinks — pnpm stores — and answers the real location). */
  typesFile: string;
  /** package.json "name" when present (5.9.3's packageId.name), else the
   * specifier's package prefix. For @types answers this is the @types
   * package's own name ("@types/foo"). */
  packageName: string;
  /** package.json "version" (packageId is only formed when it exists). */
  version?: string;
  /** Set when the node_modules package directory is a SYMLINK whose real
   * location lies outside every node_modules — a workspace-linked package
   * (pnpm/npm/yarn/bun workspaces all install internal packages this way):
   * the realpath of the package directory. The resolved typesFile then
   * carries no node_modules segment, and callers must not read that as
   * "not an npm package". */
  workspaceDir?: string;
}

/** Package name prefix of a bare specifier ("@scope/pkg/sub" → "@scope/pkg",
 * "pkg/sub" → "pkg"). */
function packagePrefixOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The DefinitelyTyped name mangling: "@scope/pkg" → "scope__pkg". */
function mangleScopedName(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
}

function packageAnswer(pkgDir: string, fallbackName: string, typesFile: string): BareResolution {
  const pkg = pkgJsonOf(pkgDir);
  const name = typeof pkg?.name === "string" && pkg.name !== "" ? pkg.name : fallbackName;
  const version = typeof pkg?.version === "string" ? pkg.version : undefined;
  return {
    typesFile: realpathOr(typesFile),
    packageName: version !== undefined ? name : fallbackName,
    ...(version !== undefined ? { version } : {}),
  };
}

/** Resolves a BARE import specifier to its npm TYPES file the way 5.9.3's
 * ts.resolveModuleName does under scriptc's options (bundler, types-only in
 * node_modules), walking node_modules directories up from the importing
 * file. Null when nothing resolves. */
export function resolveBareModule(
  fromFile: string,
  specifier: string,
  /** "js-only" forces the runtime-JS resolution regardless of the active
   * --npm-static set (the auto-detection probe); default follows the set. */
  mode?: "js-only",
): BareResolution | null {
  const pkgName = packagePrefixOf(specifier);
  const rest = specifier.slice(pkgName.length).replace(/^\//, "");
  const subpath = rest === "" ? "." : `./${rest}`;
  // An opted-in --npm-static package resolves to its RUNTIME JS: the js
  // pass only, the "types" export condition dropped, the @types mangling
  // never consulted — mirroring the shadowed world the tsgo host serves.
  const npmStatic = mode === "js-only" || isNpmStaticPackage(pkgName);
  const conditions = npmStatic ? JS_ONLY_CONDITIONS : EXPORT_CONDITIONS;

  const inPackage = (nmPkgDir: string, name: string, pass: NmPass): BareResolution | null => {
    // A workspace link: the answer's realpath escaped node_modules, so the
    // package directory is a symlink into the project. Stamp the realpath'd
    // package root so callers can classify (and register) the package.
    // Workspace trees that COPY instead of symlink leave the answer inside
    // node_modules — the workspace ROOT's "workspaces" globs still declare
    // the member, so a name match stamps the declared member directory and
    // both install shapes classify identically.
    const withWorkspace = (r: BareResolution | null): BareResolution | null => {
      if (r === null) return r;
      if (!isNodeModulesPath(r.typesFile)) {
        const realDir = realpathOr(nmPkgDir);
        if (!isNodeModulesPath(realDir)) return { ...r, workspaceDir: realDir };
      }
      const normDir = nmPkgDir.split("\\").join("/");
      const nmIdx = normDir.lastIndexOf("/node_modules/");
      const root = nmIdx > 0 ? nmPkgDir.slice(0, nmIdx) : null;
      const member = root !== null ? workspaceMemberDirOf(root, r.packageName) : null;
      // A member directory inside SOME node_modules (a published tree
      // copied under an installed package) is plain npm surface, not the
      // program author's own workspace code.
      return member !== null && !isNodeModulesPath(member) ? { ...r, workspaceDir: member } : r;
    };
    const rawPkg = pkgJsonOf(nmPkgDir);
    // The opted-in exports lookup runs over the SAME transformed document
    // the tsgo host serves (types stripped, import:=require) — the two
    // resolvers must answer one file. Cloned per lookup; never cached, so
    // the raw cache stays clean for flagless compiles.
    const pkg =
      npmStatic && rawPkg !== null
        ? (() => {
            const clone = JSON.parse(JSON.stringify(rawPkg)) as PkgJson & Record<string, unknown>;
            npmStaticTransformPkgJson(clone);
            return clone;
          })()
        : rawPkg;
    if (pkg?.exports !== undefined) {
      const target = resolveExportsTypes(pkg.exports, subpath, conditions);
      if (target !== null) {
        const file = loadTargetInPass(nmPkgDir, target, pass);
        if (file) return withWorkspace(packageAnswer(nmPkgDir, name, file));
      }
      return null;
    }
    const file = loadPathInPass(nmPkgDir, subpath === "." ? "." : `./${rest}`, pass);
    if (!file) return null;
    // A SUBPATH answered through a nested package.json (the
    // @restart/hooks/useMergedRefs shape): 5.9.3 forms the packageId from
    // THAT package.json — its (usually absent) version, not the root's.
    const subDir = subpath === "." ? null : join(nmPkgDir, rest);
    const answerDir = subDir !== null && isDirectory(subDir) && pkgJsonOf(subDir) ? subDir : nmPkgDir;
    return withWorkspace(packageAnswer(answerDir, name, file));
  };

  const passOnce = (pass: NmPass): BareResolution | null => {
    for (let dir = dirname(resolve(fromFile)); ; ) {
      const nm = join(dir, "node_modules");
      if (isDirectory(nm)) {
        // 1. The package directory.
        const viaPkg = inPackage(join(nm, pkgName), pkgName, pass);
        if (viaPkg) return viaPkg;
        // 2. The specifier as a bare FILE under node_modules.
        for (const ext of extensionsFor(pass, "plain")) {
          const asFile = join(nm, specifier + ext);
          if (isFile(asFile)) {
            return { typesFile: realpathOr(asFile), packageName: pkgName };
          }
        }
        // 3. The mangled @types package (declaration pass only).
        if (pass === "types" && !npmStatic) {
          const typesPkgName = `@types/${mangleScopedName(pkgName)}`;
          const viaTypes = inPackage(join(nm, typesPkgName), typesPkgName, pass);
          if (viaTypes) return viaTypes;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  };

  return npmStatic ? passOnce("js") : (passOnce("types") ?? passOnce("js"));
}

/** Resolves a `/// <reference types="name" />`-style TYPE DIRECTIVE the way
 * ts.resolveTypeReferenceDirective does with typeRoots emptied (the
 * secondary lookup only): walking up from the anchor file, per directory
 * node_modules/<name> then node_modules/@types/<name>, each via package.json
 * types/typings then index.d.ts. Returns the realpath'd file or null. */
export function resolveTypeDirective(name: string, fromFile: string): string | null {
  const tryPkg = (base: string): string | null => {
    const pkg = pkgJsonOf(base);
    for (const field of [pkg?.types, pkg?.typings]) {
      if (typeof field === "string" && field !== "") {
        const target = join(base, field);
        if (isFile(target)) return target;
      }
    }
    const asFile = base + ".d.ts";
    if (isFile(asFile)) return asFile;
    const idx = join(base, "index.d.ts");
    return isFile(idx) ? idx : null;
  };
  for (let dir = dirname(resolve(fromFile)); ; ) {
    const nm = join(dir, "node_modules");
    if (isDirectory(nm)) {
      const viaSelf = tryPkg(join(nm, name));
      if (viaSelf) return realpathOr(viaSelf);
      const viaTypes = tryPkg(join(nm, "@types", mangleScopedName(name)));
      if (viaTypes) return realpathOr(viaTypes);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Resolver metadata and the active project realm are shared within one
 * compile, never across compiles in a long-lived process. */
export function clearResolveCaches(): void {
  pkgJsonCache.clear();
  workspaceMembersCache.clear();
  projectRealmPkgJson = null;
}

/** True when `path` is under a node_modules directory (the
 * isExternalLibraryImport test 5.9.3 answers on resolutions). */
export function isNodeModulesPath(path: string): boolean {
  return isAbsolute(path) && path.split("/").includes("node_modules");
}
