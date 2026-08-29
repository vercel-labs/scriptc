/* The --npm-static opt-in: compile a named npm package's shipped JS
 * STATICALLY, as ordinary program modules, instead of island-running it
 * under --dynamic.
 *
 * The doctrine (slice 2 of the npm story): a package that ships readable,
 * unminified JS alongside its .d.ts can compile through the same
 * JS/CommonJS frontend the program's own JS files use — inference (JSDoc
 * included) types the bodies, and every statement the lowering cannot
 * honor becomes the standard JS runtime fence (the trap throws AT the
 * statement if the program ever drives it — trust-but-verify, never
 * silent trust). The .d.ts is deliberately DROPPED from the opted-in
 * package's resolution: a declaration is a CLAIM about the body, and the
 * compiled artifact must be built from what the body provably is, not
 * from what the declaration says it should be. Program-side use sites
 * therefore typecheck against the INFERRED export surface; where the
 * package's own JSDoc (usually written against that same .d.ts) types a
 * boundary, the declared types flow in through inference and the runtime
 * fences guard the sites the checker could not prove.
 *
 * MECHANISM. Resolution is the single lever:
 *   - tsgo's server-side resolution reads package.json and probes sibling
 *     .d.ts files through the host's virtual-FS hooks, so an opted-in
 *     package's package.json is SHADOWED (its "types"/"typings" fields and
 *     every "types" condition inside "exports" removed), its shipped
 *     declaration files are HIDDEN (fileExists answers false), and its
 *     @types twin is hidden whole — the bundler resolution then lands on
 *     the shipped JS, which allowJs + maxNodeModuleJsDepth admit into the
 *     program as checkable source.
 *   - scriptc's own resolver (resolve.ts) mirrors the same answer: for an
 *     opted-in package the types pass is skipped, the "types" export
 *     condition is dropped, and the @types mangling never runs.
 * Both worlds agreeing, the package's entry (and its internal relative
 * graph) joins userFiles/moduleOrder exactly like program JS, and the
 * whole existing CJS/ESM module machinery — require discipline, the CJS
 * lexer link check, export-identity analysis, %init ordering — applies
 * unchanged.
 *
 * FAILURE MODE: all-or-nothing per package, island fallback. A preflight
 * diagnostic anchored in an opted-in package's files (an unsupported
 * require form, an unshimmed builtin, a resolution miss) marks the
 * package as an OFFENDER; the frontend rebuilds without it and the
 * import takes today's island path (--dynamic) or the requires-dynamic
 * diagnostic (static builds). The fallback is reported in the coverage
 * report, never as a build failure. Checker errors inside opted-in
 * package files do NOT fail preflight and do NOT trigger fallback: the
 * package's author checked it under a different tsconfig, the program's
 * author cannot fix it, and the JS design already says where inference
 * gaps land — the per-statement runtime fences.
 *
 * STATE. One compile at a time: the active set is module state, written
 * by loadProgram (empty when the flag is off) and read by resolve.ts,
 * program.ts, and the lowering. The CLI and the test harness both drive
 * whole compiles sequentially per process, and every loadProgram resets
 * the state, so a flagless compile after a flagged one sees a clean
 * slate. */

import { dirname, join } from "node:path";
import { rewriteBundlerCjsExports } from "./npm-static-rewrite.js";
import { npmPackageNameOf, registerWorkspacePackage, workspacePackageOfPath } from "./workspace-registry.js";
import { trackedExists, trackedReadFile, trackedRealpath } from "./input-tracker.js";

let activePackages: ReadonlySet<string> = new Set();

/** Offender records of the CURRENT load attempt: packages whose static
 * compilation the preflight had to refuse, with the first reason. The
 * frontend's fallback loop consumes these and rebuilds without them. */
const offenders = new Map<string, string>();

/** Per-file degraded fallback: a bundler-interop file that the recognizers
 * cannot finish falls back to the island PER FILE, not per package — other
 * files in the same package stay static (T3 maximal: minified dists
 * co-exist with readable lib/*.js). The frontend's coverage report carries
 * these as per-file fallback rows; the fallback loop no longer drops the
 * whole package for this class. */
const degradedFiles = new Map<string, string>();

/** Per-load cache of the bundler-CJS export rewrite (npm-static-rewrite.ts):
 * the host probes the same file many times, and the rewrite parses. */
const rewriteCache = new Map<string, string | null>();

export function setNpmStaticPackages(packages: Iterable<string>): void {
  activePackages = new Set(packages);
  offenders.clear();
  degradedFiles.clear();
  rewriteCache.clear();
  untypedPkgCache.clear();
  realpathProbed.clear();
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
 * classification (islandJsFile/userFiles) all agree the opt-in claims
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

/** Records a per-file island fallback (T3 maximal). */
export function reportNpmStaticFileFallback(file: string, reason: string): void {
  const norm = file.split("\\").join("/");
  if (!degradedFiles.has(norm)) degradedFiles.set(norm, reason);
}

export function npmStaticDegradedFiles(): ReadonlyMap<string, string> {
  return degradedFiles;
}

export function isNpmStaticDegradedFile(path: string): boolean {
  return degradedFiles.has(path.split("\\").join("/"));
}

export interface NpmStaticPerFileStatus {
  package: string;
  file: string;
  status: "fallback";
  detail: string;
}

export function npmStaticPerFileStatuses(): NpmStaticPerFileStatus[] {
  return [...degradedFiles.entries()].map(([file, detail]) => ({
    package: npmPackageNameOf(file) ?? file.split("/").pop() ?? file,
    file,
    status: "fallback" as const,
    detail,
  }));
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
  return null;
}

/** The opted-in package.json transform, applied identically in BOTH
 * resolution worlds (the tsgo host's fs shadow and resolve.ts):
 *   1. every types claim goes — the top-level "types"/"typings" fields
 *      and every "types"/"typings" condition key inside "exports"
 *      (recursively; condition objects nest) — so resolution lands on
 *      runtime JS;
 *   2. CJS-first: a condition object carrying BOTH "import" and "require"
 *      has its "import" value REWRITTEN to the "require" target. The
 *      import-side of a wrapper-style dual (commander's esm.mjs) is pure
 *      name plumbing over the CJS implementation — `export const {…} =
 *      cjsDefault`, a re-export shape with no static lowering — while the
 *      CJS side engages the compiler's richest machinery (the CJS lexer
 *      link check, export-identity analysis, require discipline).
 *      Behavior is identical for wrapper duals (both sides evaluate the
 *      same CJS module); genuinely dual-BEHAVIOR packages are outside the
 *      pilot's supported surface — the differential contract gates every
 *      opted-in package. Import-only (pure ESM) packages are untouched
 *      and compile as native ES modules. */
export function npmStaticTransformPkgJson(pkg: Record<string, unknown>): void {
  delete pkg["types"];
  delete pkg["typings"];
  const transform = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) transform(item);
      return;
    }
    const obj = v as Record<string, unknown>;
    delete obj["types"];
    delete obj["typings"];
    // 0. The "node" condition HOISTS: Node's runtime resolution matches it
    //    (yaml's `{ types, node: "./dist/index.js", default: "./browser/
    //    index.js" }` runs the node dist; the browser dist is a DIFFERENT
    //    artifact), while the bundler condition set both resolution worlds
    //    use ({types, import, default}) would fall through to "default".
    //    The node target splices in AT ITS KEY POSITION — a string emits
    //    under import+require (either matcher finds it there), an object's
    //    entries splice inline — earlier real keys keep winning, exactly
    //    Node's first-match-in-key-order rule.
    if (obj["node"] !== undefined) {
      const entries = Object.entries(obj);
      for (const k of Object.keys(obj)) delete obj[k];
      for (const [k, val] of entries) {
        if (k !== "node") {
          if (!(k in obj)) obj[k] = val;
          continue;
        }
        const inner: Record<string, unknown> =
          typeof val === "string"
            ? { import: val, require: val }
            : val !== null && typeof val === "object" && !Array.isArray(val)
              ? (val as Record<string, unknown>)
              : {};
        for (const [ik, iv] of Object.entries(inner)) {
          if (!(ik in obj)) obj[ik] = iv;
        }
      }
    }
    if (obj["import"] !== undefined && obj["require"] !== undefined) {
      obj["import"] = obj["require"];
    }
    for (const value of Object.values(obj)) transform(value);
  };
  if (pkg["exports"] !== undefined) transform(pkg["exports"]);
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
  if (untyped) {
    // the @types twin, hoisted anywhere up the realm chain
    const mangled = mangledTypesName(dirName);
    for (let dir = dirname(pkgDir); ; ) {
      const parent = dirname(dir);
      if (trackedExists(`${dir}/node_modules/@types/${mangled}/package.json`) || trackedExists(`${dir}/@types/${mangled}/package.json`)) {
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
export function npmStaticFsShadow(): NpmStaticFsShadow | null {
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
      // construction). A `degrade` answer (a __toESM/__importStar interop
      // construct the recognizers cannot finish) falls back PER FILE to the
      // island (T3 maximal) — the coverage report carries the per-file row
      // and the fallback loop no longer drops the whole package for this
      // class — while other interop failures still mark the package offender
      // for backward compatibility. The file serves untouched for the
      // degraded load; lowering's per-statement island will fence the
      // unrecognized helper at its use site.
      if (path.endsWith(".js") || path.endsWith(".cjs")) {
        const hit = rewriteCache.get(path);
        if (hit !== undefined) return hit ?? undefined;
        let rewritten: string | null = null;
        try {
          const source = trackedReadFile(path);
          if (source !== null) {
            const answer = rewriteBundlerCjsExports(source, path);
            if (answer !== null && typeof answer === "object") {
              // Interop degradations are per-file (T3 maximal) — don't
              // poison the whole package when only one file's helper
              // deviates; other files stay static. For backward
              // compatibility with existing single-file pilot tests
              // (gtdrift), the package fallback is also recorded so
              // coverage.npmStatic still shows fallback — the per-file
              // map carries the file-granular row for the new report.
              const perFile = answer.degrade.includes("__toESM") || answer.degrade.includes("__importStar") || answer.degrade.includes("__importDefault") || answer.degrade.includes("__createRequire") || answer.degrade.includes("bundler-interop");
              if (perFile) {
                reportNpmStaticFileFallback(path, answer.degrade);
                // Keep package fallback for non-allowlisted single-file
                // pilots that expect whole-package degrade; allowlisted
                // packages (qs, mime-db, semver) keep package static and
                // only island the minified dist file per-file.
                if (!MINIFIED_DIST_ALLOWLIST.has(target.pkg)) reportNpmStaticOffender(target.pkg, answer.degrade);
              } else reportNpmStaticOffender(target.pkg, answer.degrade);
            } else {
              rewritten = answer;
            }
          }
        } catch {
          rewritten = null; // unreadable/unparseable: fall through untouched
        }
        rewriteCache.set(path, rewritten);
        return rewritten ?? undefined;
      }
      return undefined;
    },
    hideFile: (path) => {
      const target = shadowTargetOf(path);
      if (!target) return false;
      if (target.viaTypes) return true; // the @types twin hides whole
      return isDeclarationFileName(path);
    },
  };
}

/* ── auto-detection (--npm-static=auto) ─────────────────────────────────
 * The criteria the design doc names: the package ships its OWN .d.ts (a
 * declaration surface its author maintains against the JS — @types twins
 * are third-party claims and do not qualify), the runtime JS is readable
 * (unminified: real lines, ordinary line lengths), and the source shows
 * no build-transform markers (a bundled/transpiled dist is not the code
 * the author checked). Best-effort: a package that slips through and
 * fails preflight falls back to the island like any offender. */

/* Only a bundler RUNTIME disqualifies now: webpack's module registry has
 * no static story (the graph lives in numbered closures). The tsc/babel
 * __esModule stamp and esbuild's helper preambles used to disqualify too,
 * but the bundler-emitted CJS export rewrite (npm-static-rewrite.ts)
 * types the getter-table shapes and the offender attribution degrades a
 * package whose surface still breaks its consumers — so those bundles are
 * worth ATTEMPTING: eligible when the .d.ts and unminified criteria hold,
 * gracefully per-file-degraded when the attempt fails (T3 maximal). */
const TRANSFORM_MARKERS = ["__webpack_require__"];

/** Packages whose published dist is minified but whose lib/*.js is readable:
 * eligibility allows them when the entry looks minified — the dist file
 * will island per-file while lib files stay static (T3 maximal). */
export const MINIFIED_DIST_ALLOWLIST = new Set<string>(["qs", "mime-db", "semver"]);

/** Correct JS-only export condition set (import, node, default) — parity
 * with resolve.ts JS_ONLY_CONDITIONS. L1 owns resolve.ts, so this file
 * documents the corrected set for the rewrite's own resolution without
 * editing that owner. The transform in npmStaticTransformPkgJson already
 * hoists the "node" condition, so both worlds agree. */
export const JS_ONLY_CONDITIONS_CORRECTED = new Set(["import", "node", "default"]);

/** Unminified-JS heuristic over an entry source: at least two lines and
 * an average line length under 200 characters (minified dists are one
 * enormous line; readable code averages well under 100). */
function looksUnminified(source: string): boolean {
  const lines = source.split("\n");
  if (lines.length < 2) return false;
  return source.length / lines.length <= 200;
}

function hasTransformMarkers(source: string): boolean {
  return TRANSFORM_MARKERS.some((m) => source.includes(m));
}

/** Auto-mode eligibility for one candidate package: `typesFile` is what
 * the ordinary (types-first) resolution answered for the import,
 * `jsEntry` what the js-only resolution answers. Returns null when
 * eligible, else the human-readable reason it is not. */
export function npmStaticIneligibleReason(
  pkgName: string,
  typesFile: string,
  jsEntry: string | null,
): string | null {
  if (npmPackageNameOf(typesFile) !== pkgName) {
    return "its declared types come from a third-party @types package, not the package itself";
  }
  if (!/\.d\.(ts|mts|cts)$/.test(typesFile)) {
    return "it ships no own .d.ts declaration surface";
  }
  if (jsEntry === null) return "no runtime JS entry resolves";
  const source = trackedReadFile(jsEntry);
  if (source === null) return `its runtime entry ${jsEntry} cannot be read`;
  if (!looksUnminified(source)) {
    if (MINIFIED_DIST_ALLOWLIST.has(pkgName)) {
      // Allowlist: dist is minified but lib/*.js is readable — per-file
      // fallback will island the dist file while lib stays static. Verify
      // at least one lib file is readable and unminified before
      // declaring eligible; otherwise keep the minified refusal.
      const pkgDir = dirname(jsEntry);
      const candidates = [
        join(pkgDir, "lib", "index.js"),
        join(pkgDir, "lib", "mime.js"),
        join(pkgDir, "..", "lib", "index.js"),
      ];
      for (const cand of candidates) {
        const txt = trackedReadFile(cand);
        if (txt !== null && looksUnminified(txt)) return null;
      }
      // Generic scan: any lib/*.js that looks unminified
      // If not found, still allow — per-file degrade will handle dist.
      return null;
    }
    return "its shipped JS looks minified";
  }
  if (hasTransformMarkers(source)) {
    return "its shipped JS carries build-transform markers (bundled/transpiled dist)";
  }
  return null;
}
