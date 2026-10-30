/** Compile selected package implementations as program modules. The filesystem
 * shadow hides declaration-only entry points so lowering sees runtime source;
 * safe declaration contracts are projected onto that source before inference.
 * Eligibility failures and package preflight errors become explicit refusals. */
import { dirname } from "node:path";
import type { FrontendServices } from "./services.js";
import { isBundledShimForwarder } from "./package-shims.js";
import type {
  NpmStaticDeclarationOverloads,
  NpmStaticDeclarationProperties,
} from "./npm-static-declaration-syntax.js";
import {
  npmPackageNameOf,
  registerWorkspacePackage,
  workspacePackageOfPath,
} from "./workspace-registry.js";
import {
  clearVirtualSources,
  isVirtualSource,
  setVirtualSource,
  trackedExists,
  trackedReadFile,
  trackedRealpath,
} from "./input-tracker.js";
import { npmBuiltinAliasOf } from "./builtin-modules.js";
import { packageSourceText, typePatchSuppliesTypes } from "./type-patches/layer.js";

let activePackages: ReadonlySet<string> = new Set();
let declarationOverloads: ReadonlyMap<string, NpmStaticDeclarationOverloads> = new Map();
let declarationProperties: ReadonlyMap<string, NpmStaticDeclarationProperties> = new Map();

/** Offender records of the CURRENT load attempt: packages whose static
 * compilation the preflight had to refuse, with the first reason. The
 * frontend's fallback loop consumes these and rebuilds without them. */
const offenders = new Map<string, string>();

/** Per-load cache of the bundler-CJS export rewrite (npm-static-rewrite.ts):
 * the host probes the same file many times, and the rewrite parses. */
const rewriteCache = new Map<string, string | null>();

/** Rewritten files whose tail export table stands for a live getter table
 * installed before the file could run another module's code (the rewrite
 * certifies it; require-cycle admission consults it). */
const liveExportFiles = new Set<string>();

export function npmStaticLiveExportTable(path: string): boolean {
  return liveExportFiles.has(path.split("\\").join("/"));
}

/** Names Node's lexer detects in a rewritten file's original text that
 * its rewrite spells only as accessors (the lexer skips those). */
const lexerNames = new Map<string, readonly string[]>();

export function npmStaticLexerVisibleNames(path: string): readonly string[] {
  return lexerNames.get(path.split("\\").join("/")) ?? [];
}

/** The suffix that replaces `.d.ts` in the name of a copy of an opted-in
 * package's declaration file (npm-static-type-exports.ts). Defined here so
 * this module does not depend on the syntax modules. */
export const NPM_STATIC_TYPES_SUFFIX = ".scriptc-types.d.ts";

/** Per runtime entry (forward slashes), the JSDoc typedefs that re-export
 * its package's type-only declarations (npm-static-type-exports.ts). */
let typeExportTypedefs = new Map<string, string>();

/** Registers the copies of the opted-in packages' declaration files and the
 * typedefs their runtime entries gain (after setNpmStaticPackages, which
 * clears virtual sources). */
export function setNpmStaticTypeExports(
  copies: ReadonlyMap<string, string>,
  typedefs: ReadonlyMap<string, string>,
): void {
  for (const [path, text] of copies) setVirtualSource(path, text);
  typeExportTypedefs = new Map(typedefs);
  rewriteCache.clear();
}

/** `text` (or the file's own text when null) with the typedefs of a
 * package runtime entry appended: the entry re-exports the type-only
 * declarations of the package's .d.ts, after every respelling, so
 * positions stay. Null when `path` is no runtime entry and `text` is null. */
function withTypeExportTypedefs(path: string, text: string | null): string | null {
  const typedefs = typeExportTypedefs.get(path.split("\\").join("/"));
  if (typedefs === undefined) return text;
  const source = text ?? packageSourceText(path);
  return source === null ? text : `${source}\n${typedefs}\n`;
}

export function setNpmStaticPackages<T extends Iterable<string>>(packages: T): void {
  // npm packages served as builtins (graceful-fs as fs) never compile
  // their JavaScript, even when named.
  activePackages = new Set([...packages].filter((name) => npmBuiltinAliasOf(name) === null));
  typeExportTypedefs = new Map();
  declarationOverloads = new Map();
  declarationProperties = new Map();
  offenders.clear();
  fileDegrades.clear();
  rewriteCache.clear();
  liveExportFiles.clear();
  lexerNames.clear();
  clearVirtualSources();
  untypedPkgCache.clear();
  realpathProbed.clear();
  aliasNames.clear();
}

export function setNpmStaticDeclarationOverloads(
  overloads: ReadonlyMap<string, NpmStaticDeclarationOverloads>,
  properties: ReadonlyMap<string, NpmStaticDeclarationProperties> = new Map(),
): void {
  declarationOverloads = overloads;
  declarationProperties = properties;
  rewriteCache.clear();
}

export function npmStaticActive(): boolean {
  return activePackages.size > 0;
}

export function isNpmStaticPackage(name: string | null): boolean {
  return name !== null && activePackages.has(name);
}

/** The opted-in package a path belongs to, or null. Attribution uses the
 * INNERMOST node_modules segment (a nested install is its own package);
 * paths with NO node_modules segment consult the workspace registry — an
 * opted-in WORKSPACE package's files live at realpaths outside every
 * node_modules (the symlinked-install shape), and they are that package's
 * files for every consumer of this answer: the fallback loop's offender
 * attribution, the checker-error suppression, and the program-source
 * classification (unselectedPackageJsFile/userFiles) all agree the opt-in claims
 * them. */
export function npmStaticPackageOfPath(path: string): string | null {
  const pkg = npmPackageNameOf(path);
  if (pkg !== null) return activePackages.has(pkg) ? pkg : null;
  const ws = workspacePackageOfPath(path.split("\\").join("/"));
  return ws !== null && activePackages.has(ws) ? ws : null;
}

/** Records why a package cannot compile statically this attempt (first
 * reason wins — one line per package in the coverage note). */
export function reportNpmStaticOffender(pkg: string, reason: string): void {
  if (activePackages.has(pkg) && !offenders.has(pkg)) offenders.set(pkg, reason);
}

export function npmStaticOffenders(): ReadonlyMap<string, string> {
  return offenders;
}

/** Files whose bundler interop the rewrite could not finish this attempt,
 * with their package and reason. A file refuses its package only when
 * the compiled program can load it (npmStaticLoadableFiles): a package is
 * judged by what its imported subpaths reach, not by every file it ships. */
const fileDegrades = new Map<string, { pkg: string; reason: string }>();

export function npmStaticFileDegrades(): ReadonlyMap<string, { pkg: string; reason: string }> {
  return fileDegrades;
}

function reportFileDegrade(path: string, pkg: string, reason: string): void {
  const key = path.split("\\").join("/");
  if (!fileDegrades.has(key)) fileDegrades.set(key, { pkg, reason });
}

/** The DefinitelyTyped name mangling ("@scope/pkg" → "scope__pkg") — the
 * @types twin that must hide alongside the package's own declarations. */
function mangledTypesName(name: string): string {
  return name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
}

/** See shadowTargetOf: realpaths an opted-in package's node_modules dir
 * once per load and registers workspace-symlinked installs. */
const realpathProbed = new Set<string>();

function registerWorkspaceRealpath(pkg: string, nmDir: string): void {
  if (realpathProbed.has(nmDir)) return;
  realpathProbed.add(nmDir);
  const real = trackedRealpath(nmDir)?.split("\\").join("/");
  if (real !== undefined && real !== nmDir && !real.includes("/node_modules/")) {
    registerWorkspacePackage(pkg, real);
  }
}

/** node_modules path classification for the fs shadow: which opted-in
 * package (if any) the path is inside, and whether it is inside that
 * package's @types twin instead. A path with no node_modules segment can
 * still be an opted-in WORKSPACE package's real home (the symlinked
 * install's realpath — loadProgram registers those before the host is
 * created, so probes along the package's internal relative edges hide the
 * declaration twins too). */
function shadowTargetOf(path: string): { pkg: string; viaTypes: boolean } | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) {
    const ws = workspacePackageOfPath(norm);
    return ws !== null && activePackages.has(ws) ? { pkg: ws, viaTypes: false } : null;
  }
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  if (activePackages.has(dirName)) {
    /* An opted-in package first seen through a node_modules path may be a
     * WORKSPACE SYMLINK whose realpath escapes node_modules — and the
     * host reads file CONTENT at realpaths, where nothing path-shaped
     * marks the package. The entry-anchored probe in loadProgram misses
     * nested realms (a monorepo driver outside every package realm), so
     * the shadow registers the realpath the moment resolution touches the
     * symlink — always before any content read along it. */
    registerWorkspaceRealpath(dirName, `${norm.slice(0, idx)}/node_modules/${dirName}`);
    return { pkg: dirName, viaTypes: false };
  }
  if (first === "@types") {
    const mangled = parts[1] ?? "";
    for (const pkg of activePackages) {
      if (mangledTypesName(pkg) === mangled) return { pkg, viaTypes: true };
    }
  }
  // An npm alias (`"x-updated": "npm:x@6.3.0"`) installs the package under
  // another directory name: its own manifest names the package.
  const aliased = aliasedPackageName(`${norm.slice(0, idx)}/node_modules/${dirName}`);
  if (aliased !== null && aliased !== dirName && activePackages.has(aliased))
    return { pkg: aliased, viaTypes: false };
  return null;
}

/** The "name" a node_modules directory's own package.json declares, or
 * null (cached per load). */
const aliasNames = new Map<string, string | null>();
function aliasedPackageName(pkgDir: string): string | null {
  const hit = aliasNames.get(pkgDir);
  if (hit !== undefined) return hit;
  let name: string | null = null;
  try {
    const text = trackedReadFile(`${pkgDir}/package.json`);
    const declared = text === null ? undefined : (JSON.parse(text) as { name?: unknown }).name;
    if (typeof declared === "string") name = declared;
  } catch {
    name = null;
  }
  aliasNames.set(pkgDir, name);
  return name;
}

/** The opted-in package.json transform, applied identically in BOTH
 * resolution worlds (the tsgo host's fs shadow and resolve.ts):
 *   1. every types claim goes — the top-level "types"/"typings" fields
 *      and every "types"/"typings" condition key inside "exports"
 *      (recursively; condition objects nest) — so resolution lands on
 *      runtime JS;
 *   2. preserve distinct import and require targets. Static compilation
 *      must execute the same module Node selects, including packages that
 *      ship separate ESM and CommonJS builds. */
export function npmStaticTransformPkgJson(pkg: Record<string, unknown>): void {
  delete pkg["types"];
  delete pkg["typings"];
  const transform = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(transform);
    // The result is a new object, built in key order; the first entry of a
    // key wins.
    const entries: [string, unknown][] = [];
    const seen = new Set<string>();
    const add = (key: string, value: unknown): void => {
      if (seen.has(key)) return;
      seen.add(key);
      entries.push([key, value]);
    };
    // 0. The "node" condition HOISTS: Node's runtime resolution matches it
    //    (yaml's `{ types, node: "./dist/index.js", default: "./browser/
    //    index.js" }` runs the node dist; the browser dist is a DIFFERENT
    //    artifact), while the bundler condition set both resolution worlds
    //    use ({types, import, default}) would fall through to "default".
    //    The node target splices in AT ITS KEY POSITION — a string emits
    //    under import+require (either matcher finds it there), an object's
    //    entries splice inline — earlier real keys keep winning, exactly
    //    Node's first-match-in-key-order rule.
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (key !== "node") {
        add(key, value);
        continue;
      }
      const inner: Record<string, unknown> =
        typeof value === "string"
          ? { import: value, require: value }
          : value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
      for (const [innerKey, innerValue] of Object.entries(inner)) add(innerKey, innerValue);
    }
    // 1. The types claims go AFTER the hoist: a node object's own
    //    "types" key (uuid's `node: { types: "./dist/index.d.ts", default:
    //    "./dist-node/index.js" }`) splices in with its siblings, and left
    //    in place tsgo follows it, maps the hidden declaration to its
    //    same-stem JS (dist/index.js, the browser build) and disagrees with
    //    this resolver's runtime answer.
    return Object.fromEntries(
      entries
        .filter(([key]) => key !== "types" && key !== "typings")
        .map(([key, value]): [string, unknown] => [key, transform(value)]),
    );
  };
  if (pkg["exports"] !== undefined) pkg["exports"] = transform(pkg["exports"]);
  // The "imports" field maps "#" specifiers with the same condition objects
  // (chalk 5's `"#supports-color": { node, default }`), so Node's "node"
  // target hoists there too.
  if (pkg["imports"] !== undefined) pkg["imports"] = transform(pkg["imports"]);
}

/** npmStaticTransformPkgJson over a package.json TEXT (the fs shadow's
 * form). Malformed documents pass through untouched — resolution reports
 * them exactly as it always did. */
function npmStaticTransformPkgJsonText(text: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return text;
  npmStaticTransformPkgJson(doc as Record<string, unknown>);
  // tsgo deduplicates installs by package id (name + version): a second
  // copy of the same name@version (express/node_modules/fresh beside
  // send/node_modules/fresh) becomes a redirect to the first copy loaded,
  // so its own path never joins the program. Node loads every installed
  // copy as its own module, and resolve.ts answers each importer's own
  // copy; without a version the checker keeps the copies apart too.
  delete (doc as Record<string, unknown>)["version"];
  return JSON.stringify(doc);
}

/** True for declaration-file names (the claims the opted-in resolution
 * must not see). */
function isDeclarationFileName(path: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(path) || path.endsWith(".d.json.ts");
}

function isNodeModulesPathNorm(path: string): boolean {
  return path.split("\\").join("/").includes("/node_modules/");
}

/** Whether the package owning `path` is UNTYPED for the checker: no
 * "types"/"typings" claim, no root .d.ts entry, and no installed @types
 * twin along the walk-up — the packages whose flagless import surface is
 * `any` (see the any-surface stub in the fs shadow). Cached per package
 * directory for the load's lifetime. */
const untypedPkgCache = new Map<string, boolean>();

function packageIsUntyped(path: string): boolean {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return false;
  const rest = norm.slice(idx + "/node_modules/".length);
  const parts = rest.split("/");
  const first = parts[0] ?? "";
  if (first.startsWith("@types")) return false; // a twin IS the types
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  const pkgDir = `${norm.slice(0, idx)}/node_modules/${dirName}`;
  const hit = untypedPkgCache.get(pkgDir);
  if (hit !== undefined) return hit;
  let untyped = true;
  try {
    const pkgText = trackedReadFile(`${pkgDir}/package.json`);
    if (pkgText !== null) {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      if (pkg["types"] !== undefined || pkg["typings"] !== undefined) untyped = false;
      if (untyped && typeof pkg["exports"] === "object" && pkg["exports"] !== null) {
        // a "types" condition anywhere inside exports is a claim too
        untyped = !JSON.stringify(pkg["exports"]).includes('"types"');
      }
    }
  } catch {
    /* no package.json — keep probing */
  }
  if (untyped && trackedExists(`${pkgDir}/index.d.ts`)) untyped = false;
  if (untyped && typePatchSuppliesTypes(pkgDir)) untyped = false;
  if (untyped) {
    // the @types twin, hoisted anywhere up the realm chain
    const mangled = mangledTypesName(dirName);
    for (let dir = dirname(pkgDir); ;) {
      const parent = dirname(dir);
      if (
        trackedExists(`${dir}/node_modules/@types/${mangled}/package.json`) ||
        trackedExists(`${dir}/@types/${mangled}/package.json`)
      ) {
        untyped = false;
        break;
      }
      if (parent === dir) break;
      dir = parent;
    }
  }
  untypedPkgCache.set(pkgDir, untyped);
  return untyped;
}

/** An installed TypeScript source with no runtime JavaScript at its stem
 * (tldts ships `index.ts` beside `main: "dist/cjs/index.js"`). Node never
 * executes TypeScript under node_modules and resolve.ts answers only
 * runtime JS for opted-in packages, yet tsgo's TypeScript-first lookup
 * would take the package-root `index.ts` over `main`. A same-stem JS twin
 * keeps the source visible: that pair is the shape npmStaticProgramDep
 * accepts in the JavaScript's place. */
function isUnloadableInstalledTsSource(path: string): boolean {
  if (!/\.(ts|tsx|mts|cts)$/.test(path) || isDeclarationFileName(path)) return false;
  if (!isNodeModulesPathNorm(path)) return false;
  const stem = path.replace(/\.(ts|tsx|mts|cts)$/, "");
  return ![".js", ".jsx", ".mjs", ".cjs"].some((ext) => trackedExists(stem + ext));
}

export interface NpmStaticFsShadow {
  /** Shadowed CONTENT for a real path (the types-stripped package.json),
   * or undefined (no shadow — fall through). */
  readFile: (path: string) => string | undefined;
  /** True when the path must not exist for the type-checker's resolution
   * (an opted-in package's shipped .d.ts, or its @types twin whole). */
  hideFile: (path: string) => boolean;
}

/** The virtual-FS shadow loadProgram hands the tsgo host — null when the
 * flag is off, so flagless compiles keep the exact host behavior. */
export function npmStaticFsShadow(services: FrontendServices): NpmStaticFsShadow | null {
  if (!npmStaticActive()) return null;
  return {
    readFile: (path) => {
      const target = shadowTargetOf(path);
      /* NON-OPTED node_modules JS: maxNodeModuleJsDepth (set only on
       * --npm-static loads) admits third-party JS the flagless build never
       * types, and an UNTYPED package's inferred surface would then
       * replace the `any` its imports contribute flagless — changing the
       * PROGRAM's own types under a flag that promised to touch only the
       * opted-in packages (the jaro-winkler shape: an @ts-ignore'd import
       * whose result feeds program arithmetic). Serve those files as the
       * any-surface stub instead: the import types exactly what the
       * flagless build typed. Typed packages (own .d.ts or an installed
       * @types twin) resolve types-first and never reach here. */
      if (!target) {
        if (
          (path.endsWith(".js") || path.endsWith(".cjs")) &&
          isNodeModulesPathNorm(path) &&
          !trackedExists(path.replace(/\.(js|cjs)$/, ".d.ts")) && // a sibling .d.ts types this very file
          packageIsUntyped(path)
        ) {
          return "module.exports = (() => { let u; return u; })();\n";
        }
        return undefined;
      }
      if (target.viaTypes) return undefined;
      if (path.endsWith("/package.json") || path.endsWith("\\package.json")) {
        try {
          const source = trackedReadFile(path);
          return source === null ? undefined : npmStaticTransformPkgJsonText(source);
        } catch {
          return undefined;
        }
      }
      // Bundler-emitted CJS files get their export surface respelled in
      // the plain CJS both worlds model (npm-static-rewrite.ts) — the ONE
      // program serves checker and lowering, so the rewrite is the text
      // everywhere downstream (statement walks, the CJS lexer link check,
      // diagnostics rendering; original line offsets survive by
      // construction). A `degrade` answer (a __toESM interop construct the
      // recognizers cannot finish) marks the PACKAGE an offender with the
      // reason — the selection loop records a package refusal — and
      // the file serves untouched for the doomed load.
      if (path.endsWith(".js") || path.endsWith(".cjs")) {
        const hit = rewriteCache.get(path);
        if (hit !== undefined) return hit ?? undefined;
        let rewritten: string | null = null;
        try {
          // A project type patch (type-patches/layer.ts) edits the text
          // as the package wrote it, before any rewrite reads its JSDoc
          // (unrewritten files fall through to the host, which serves the
          // patched text too).
          let original = packageSourceText(path);
          // A bundle's CommonJS chunks move to their own modules first, so
          // every later pass (and this shadow, for each chunk) sees plain
          // CommonJS module text.
          const split = original === null ? null : services.splitCjsChunks(original, path);
          if (split !== null && "degrade" in split) {
            reportFileDegrade(path, target.pkg, split.degrade);
            original = null;
          } else if (split !== null) {
            for (const chunk of split.chunks) setVirtualSource(chunk.path, chunk.source);
            original = split.text;
          }
          // Then its lazily initialized ES modules become run-once closures.
          const esm = original === null ? null : services.lowerEsmInits(original, path);
          if (esm !== null && typeof esm === "object") {
            reportFileDegrade(path, target.pkg, esm.degrade);
            original = null;
          } else if (esm !== null) {
            original = esm;
          }
          // TypeScript's UMD wrapper calls its factory with the module's own
          // require and exports: the factory body is the module body.
          const umd = original === null ? null : services.umdFactory(original, path);
          if (umd !== null) original = umd;
          // Polyfill packages that ARE a Node builtin compile as the builtin.
          const aliased = original === null ? null : services.builtinAliasRequires(original, path);
          if (aliased !== null) original = aliased;
          // tsc's interop helpers around builtin modules.
          const tscHelpers = original === null ? null : services.tscBuiltinImports(original, path);
          if (tscHelpers !== null) original = tscHelpers;
          // A module exporting one of its functions reaches its members
          // through that function.
          const fnExports = original === null ? null : services.cjsFunctionExports(original, path);
          if (fnExports !== null) original = fnExports;
          // TypeScript's enum IIFEs with literal members become the object
          // literals they build.
          const enums = original === null ? null : services.enumIifes(original, path);
          if (enums !== null) original = enums;
          // Guarded namespace declarations (`var ns = ns || {}`) read the
          // hoisted `undefined`: the declaration is its default.
          const namespaces = original === null ? null : services.namespaceDefaults(original, path);
          if (namespaces !== null) original = namespaces;
          // A module that names its export object through a variable reaches
          // its members through `exports`.
          const exportsVar = original === null ? null : services.cjsExportsVar(original, path);
          if (exportsVar !== null) original = exportsVar;
          const respelled =
            split !== null ||
            umd !== null ||
            tscHelpers !== null ||
            esm !== null ||
            aliased !== null ||
            fnExports !== null ||
            enums !== null ||
            namespaces !== null ||
            exportsVar !== null;
          if (original !== null) {
            const namepaths = services.jsDocNamepaths(path, original);
            const source = namepaths ?? original;
            const classFields = services.nullableClassFields(path, source);
            const findWidened = services.findReturnWidening(path, classFields?.text ?? source);
            const propertyProjected = services.declarationProperties(
              path,
              findWidened?.text ?? classFields?.text ?? source,
              declarationProperties.get(path.split("\\").join("/")) ?? new Map(),
            );
            const projected = services.declarationOverloads(
              path,
              propertyProjected?.text ?? findWidened?.text ?? classFields?.text ?? source,
              declarationOverloads.get(path.split("\\").join("/")) ?? new Map(),
            );
            const answer = services.rewriteCjs(
              projected?.text ??
                propertyProjected?.text ??
                findWidened?.text ??
                classFields?.text ??
                source,
              path,
              (live) => liveExportFiles.add(live.split("\\").join("/")),
              (file, names) => lexerNames.set(file.split("\\").join("/"), names),
            );
            if (answer !== null && typeof answer === "object") {
              reportFileDegrade(path, target.pkg, answer.degrade);
            } else {
              rewritten =
                answer ??
                projected?.text ??
                propertyProjected?.text ??
                findWidened?.text ??
                classFields?.text ??
                namepaths ??
                (respelled ? original : null);
            }
          }
        } catch {
          rewritten = null; // unreadable/unparseable: fall through untouched
        }
        rewritten = withTypeExportTypedefs(path, rewritten);
        rewriteCache.set(path, rewritten);
        return rewritten ?? undefined;
      }
      // Other runtime entries (`.mjs`) keep their text and gain only the
      // typedefs.
      return withTypeExportTypedefs(path, null) ?? undefined;
    },
    hideFile: (path) => {
      // The copies of the package's declaration files the typedefs name.
      if (path.endsWith(NPM_STATIC_TYPES_SUFFIX) && isVirtualSource(path)) return false;
      const target = shadowTargetOf(path);
      if (!target) return false;
      if (isBundledShimForwarder(path)) return false;
      if (target.viaTypes) return true; // the @types twin hides whole
      return isDeclarationFileName(path) || isUnloadableInstalledTsSource(path);
    },
  };
}

const programAliasCache = new Map<string, string | null>();

/** The always-on program-file half of the builtin aliases: a CommonJS
 * program file's `require("<polyfill package>")` compiles as the builtin
 * the package is on Node 24 (npm-static-builtin-aliases.ts), as in an
 * opted-in package's files. Undefined for every other path, so TypeScript
 * programs and JavaScript without such a require read the file as is. */
export function programBuiltinAliasSource(
  services: FrontendServices,
  path: string,
): string | undefined {
  if (!/\.c?js$/.test(path) || isNodeModulesPathNorm(path)) return undefined;
  const hit = programAliasCache.get(path);
  if (hit !== undefined) return hit ?? undefined;
  let rewritten: string | null = null;
  try {
    const source = trackedReadFile(path);
    if (source !== null) rewritten = services.builtinAliasRequires(source, path);
  } catch {
    rewritten = null;
  }
  programAliasCache.set(path, rewritten);
  return rewritten ?? undefined;
}

/** Resets the program-file alias cache (once per program load). */
export function clearProgramBuiltinAliasCache(): void {
  programAliasCache.clear();
}

/* Only a bundler RUNTIME disqualifies now: webpack's module registry has
 * no static story (the graph lives in numbered closures). The tsc/babel
 * __esModule stamp and esbuild's helper preambles used to disqualify too,
 * but the bundler-emitted CJS export rewrite (npm-static-rewrite.ts)
 * types the getter-table shapes and the offender attribution degrades a
 * package whose surface still breaks its consumers — so those bundles are
 * worth ATTEMPTING: eligible when the .d.ts criteria hold, gracefully
 * per-package-degraded when the attempt fails. Minified JS is attempted
 * too: a minified dist is ordinary JavaScript, and the bundle recognizers
 * know esbuild's __commonJS helper by its shape under any name. */
const TRANSFORM_MARKERS = ["__webpack_require__"];

function hasTransformMarkers(source: string): boolean {
  return TRANSFORM_MARKERS.some((m) => source.includes(m));
}

/** Why the declarations at `typesFile` cannot stand for the runtime
 * package `pkg`, or null when they are its DefinitelyTyped twin
 * (`@types/<mangled pkg>`). The declarations only check the importing
 * program; the JavaScript compiles with its inferred types, and an
 * inferred surface the program does not typecheck against refuses the
 * package afterwards, whatever release the twin describes. */
export function definitelyTypedMismatch(pkg: string, typesFile: string): string | null {
  const owner = npmPackageNameOf(typesFile.split("\\").join("/"));
  const twin = `@types/${mangledTypesName(pkg)}`;
  return owner === twin
    ? null
    : `its declared types come from ${owner ?? typesFile}, which is not ${pkg}'s DefinitelyTyped package ${twin}`;
}

/** Auto-mode eligibility for one candidate package: `typesFile` is what
 * the ordinary (types-first) resolution answered for the import,
 * `jsEntry` what the js-only resolution answers. Returns null when
 * eligible, else the human-readable reason it is not. */
export function npmStaticIneligibleReason(
  pkgName: string,
  typesFile: string,
  jsEntry: string | null,
  /** A dependency another package's JavaScript imports: no declarations
   * check that importer, so the package need not ship its own. */
  untypedDependency = false,
): string | null {
  if (!untypedDependency) {
    if (npmPackageNameOf(typesFile) !== pkgName) {
      return "its declared types come from a third-party @types package, not the package itself";
    }
    if (!/\.d\.(ts|mts|cts)$/.test(typesFile)) {
      return "it ships no own .d.ts declaration surface";
    }
  }
  if (jsEntry === null) return "no runtime JS entry resolves";
  const source = trackedReadFile(jsEntry);
  if (source === null) return `its runtime entry ${jsEntry} cannot be read`;
  if (hasTransformMarkers(source)) {
    return "its shipped JS carries build-transform markers (bundled/transpiled dist)";
  }
  return null;
}
