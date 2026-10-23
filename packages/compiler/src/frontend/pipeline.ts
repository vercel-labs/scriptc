/** Shared frontend orchestration. Hosts supply a program loader so Node
 * and native callers use the same npm selection, preflight and lowering. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import { entryFunctionExports, type EntryExportInfo } from "./lib-exports.js";
import { entryContractFacts, type ContractFacts } from "./lib-contract.js";
import {
  canonicalBuiltinModule,
  npmBuiltinAliasOf,
  checkPreflight,
  isNodeTypesPath,
  locOf,
  npmStaticDepSf7,
  npmStaticLoadableFiles,
  requiresOf,
  resolveImport,
  resolveNpmImport,
  type LoadResult,
} from "./program.js";
import {
  definitelyTypedMismatch,
  npmStaticFileDegrades,
  npmStaticIneligibleReason,
  npmStaticOffenders,
  npmStaticPackageOfPath,
} from "./npm-static.js";
import { clearResolveCaches, resolveBareModule, resolveWorkspaceSourceModule } from "./resolve.js";
import { isShimmedImport } from "./package-shims.js";
import { provenanceEntryFor } from "./provenance-registry.js";
import { isJsSourceFileName } from "./tsc-codes.js";
import { isRelativeSpecifier, packageNameOfSpecifier } from "./workspace-registry.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./lowering/lowerer.js";
import type { FrontendServices } from "./services.js";
import {
  isIdentifier,
  isImportDeclaration,
  isExportDeclaration,
  isStringLiteral,
  isStringLiteralLike,
  SyntaxKind,
  type SourceFile,
} from "./ts7/adapter.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";
import { CONTRACT_TYPES_MODULE } from "./contract-types.js";
import { THREADS_MODULE } from "./threads-import.js";
import { NODE_API_MODULE } from "./node-api-import.js";
import { erasedTypeOnlyImport } from "./type-only-imports.js";
import { EXPERIMENTAL_MODULE } from "./experimental-import.js";
import { readProjectConfig } from "../project-config.js";
import { setFrontendIslands } from "../node-islands/boundary.js";
import { packageDirOf } from "../node-islands/origin.js";
import {
  scanFiles,
  type NodeIslandScan,
  type RefusalKind,
  type RefusalRecord,
} from "../node-islands/scan.js";

/** Where a package-anchored preflight diagnostic sits, as
 * `<package path>:<line>` — the SC2013 refusal that drops the package
 * reports only at the consumer's import, so its reason carries the inner
 * location. */
function packageDiagWhere(load: LoadResult, loc: SrcLoc): string {
  const file = loc.file.split("\\").join("/");
  const at = file.lastIndexOf("/node_modules/");
  const shown = at >= 0 ? file.slice(at + "/node_modules/".length) : file;
  const text = load.program.getSourceFile(loc.file)?.text;
  if (text === undefined) return shown;
  let line = 1;
  for (let i = 0; i < loc.start && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return `${shown}:${line}`;
}

export interface ProgramLoadOptions {
  npmStatic?: readonly string[];
  externalTypes?: Readonly<Record<string, string>> | undefined;
}

/** A load owns its program resources until LoadResult.dispose(). Host
 * transports may own additional resources around the whole frontend. */
export type ProgramLoader = (
  entryPath: string,
  options: ProgramLoadOptions,
) => LoadResult & {
  services: FrontendServices;
  dispose: () => void;
};

/* ── the frontend, one pipeline shape ───────────────────────────────────
 * Load → preflight → lowering all ride the ONE tsgo program (program.ts +
 * lowering/ over the ts7 adapter) — the native TypeScript compiler is the
 * only frontend since the phase-4 flip retired the 5.9.3 pipeline
 * (typescript@5.9.3 survives solely behind the source-string parser and
 * transpilation islands enforced by scripts/test-ts7.mjs). Everything after
 * lowering is IR-world, so analyze() and compile() consume this one
 * Frontend shape. */
export interface Frontend {
  preflight: ScrDiagnostic[];
  /** The entry source file's text for diagnostics and source annotations. */
  entryText: () => string;
  /** Library mode's resolution input: the entry file's exported function
   * declarations (call before dispose — it reads the ts7 AST). */
  entryExports: () => Map<string, EntryExportInfo>;
  /** The contract sidecar's projection input: the entry file's exported
   * function signatures and convention consts, plus the whole graph's
   * exported type declarations, in declaration order (call before
   * dispose — it reads the ts7 AST). */
  entryContract: () => ContractFacts;
  sourceTexts: () => Map<string, string>;
  lower: (opts: LowerOptions) => LowerResult;
  /** Each requested or detected package's native compilation outcome,
   * including the first refusal reason for ineligible packages. */
  npmStatic: NpmStaticStatus[];
  /** Each judged npm package's first import site, used to anchor refusals. */
  npmImportSites: ReadonlyMap<string, SrcLoc>;
  /** The Node island detector's input (report-only): the program's
   * modules with their pre-scan markers, package import edges, and how
   * each refused package was refused. Call before dispose. */
  nodeIslandScan?: (opts: { userJs: boolean }) => NodeIslandScan;
  /** Releases the frontend's resources (the spawned tsgo server). Call
   * exactly once, after the last lower(). */
  dispose: () => void;
}

/** Hosts own transport lifetimes; shared compiler stages own the frontend. */
export type FrontendFactory = (
  entryPath: string,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic?: readonly string[],
  /** Packages that run in Node islands (scope-B NI-4): never compiled,
   * typed by their declarations. */
  nodeIslands?: ReadonlySet<string>,
) => Frontend;

/** Adds the program modules a literal `import()` reaches to `scanned`,
 * with their own static import graphs: they load at the call, outside the
 * startup module order, and their npm imports are dependencies all the
 * same (a workspace package loaded on demand, the vercel.ts config parser
 * shape). An opted-in package's JavaScript reached that way joins too,
 * with every file its literal require() and import edges load: those
 * files are outside the module order as well, and the packages THEY
 * require (a compiled CommonJS dist requiring a sibling package) are
 * dependencies the selection must see. */
function addDynamicImportGraph(load: LoadResult, scanned: Set<SourceFile>): void {
  const queue = [...scanned];
  const added = new Set<SourceFile>();
  while (queue.length > 0) {
    const sf = queue.pop()!;
    const packageJs = sf.fileName.includes("/node_modules/");
    if (packageJs && !added.has(sf)) continue;
    const specs: { spec: string; kind: "import" | "require" }[] = [];
    // Every literal import() in the file, read from the syntax: a comment
    // can stand between the keyword and its parenthesis. A file without
    // the keyword has none. Package JavaScript loads its literal require()
    // calls the same way, nested ones included.
    const calls =
      packageJs || sf.text.includes("import") ? moduleSourceCandidates(load.program, sf).calls : [];
    for (const call of calls) {
      const arg = call.arguments.nodes[0];
      if (arg === undefined || !isStringLiteralLike(arg)) continue;
      if (call.expression.kind === SyntaxKind.ImportKeyword)
        specs.push({ spec: arg.text, kind: "import" });
      else if (packageJs && isIdentifier(call.expression) && call.expression.text === "require")
        specs.push({ spec: arg.text, kind: "require" });
    }
    // The startup graph's static edges are already in the module order.
    if (added.has(sf)) {
      for (const stmt of sf.statements.nodes) {
        if (
          (isImportDeclaration(stmt) || isExportDeclaration(stmt)) &&
          stmt.moduleSpecifier &&
          isStringLiteral(stmt.moduleSpecifier) &&
          !(isImportDeclaration(stmt) ? erasedTypeOnlyImport(stmt) : stmt.isTypeOnly)
        )
          specs.push({ spec: stmt.moduleSpecifier.text, kind: "import" });
      }
    }
    for (const { spec, kind } of specs) {
      if (canonicalBuiltinModule(spec) !== null) continue;
      // Only the JavaScript of a package the selection already opted in:
      // a package's declarations load nothing.
      const dep =
        resolveImport(load.program, sf, spec, kind) ??
        npmStaticDepSf7(load.program, sf, spec, kind);
      if (dep === null || scanned.has(dep)) continue;
      if (dep.fileName.includes("/node_modules/") && !isJsSourceFileName(dep.fileName)) continue;
      scanned.add(dep);
      added.add(dep);
      queue.push(dep);
    }
  }
}

function detectAutoPackages(
  load: LoadResult,
  statuses: NpmStaticStatus[],
  mode: "auto" | "lib" = "auto",
  judged?: Set<string>,
  sites?: Map<string, SrcLoc>,
  transitive: Set<string> = new Set(),
): string[] {
  const chosen: string[] = [];
  // package → the resolved types file AND the file whose import found it:
  // the runtime-JS probe below must resolve from the SAME importing file,
  // or a package visible only to a nested package.json realm (a pnpm
  // monorepo's packages/*/node_modules, unreachable from the entry's own
  // walk-up) answers "no runtime JS" for perfectly ordinary installs.
  const seen = new Map<
    string,
    { typesFile: string; fromFile: string; spec: string; owner: string | null }
  >();
  // A transitive package's files outside the module order (reached through
  // nested require() calls the graph walk does not model) still name its
  // dependencies.
  const scanned = new Set([...load.moduleOrder, load.entry]);
  addDynamicImportGraph(load, scanned);
  const transitiveFiles =
    transitive.size === 0
      ? []
      : load.program.getImplementationSourceFiles().filter((sf) => {
          const pkg = npmStaticPackageOfPath(sf.fileName);
          return !scanned.has(sf) && pkg !== null && transitive.has(pkg);
        });
  for (const sf of [...scanned, ...transitiveFiles]) {
    if (mode === "auto" && sf.fileName.includes("/node_modules/")) continue;
    // `--npm-static=pkg...` opts pkg's whole dependency closure in: every
    // package its compiled files import is selected the same explicit way,
    // without the declaration eligibility bar.
    const owner = npmStaticPackageOfPath(sf.fileName);
    const viaTransitive = owner !== null && transitive.has(owner);
    const edges: { spec: string; loc: SrcLoc }[] = [];
    for (const stmt of sf.statements.nodes) {
      if (
        (isImportDeclaration(stmt) || isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        isStringLiteral(stmt.moduleSpecifier)
      ) {
        // `import type` and `export type … from` erase under Node's type
        // stripping: Node never loads the package, so it is no dependency
        // to compile (its declarations still type the program).
        if (isImportDeclaration(stmt) ? erasedTypeOnlyImport(stmt) : stmt.isTypeOnly) continue;
        edges.push({ spec: stmt.moduleSpecifier.text, loc: locOf(stmt) });
      } else if (mode === "lib" && !viaTransitive) {
        // CJS packages spell their dep edges as top-level requires; the
        // import-statement scan alone would miss every one of them.
        for (const req of requiresOf(stmt)) edges.push({ spec: req.spec, loc: locOf(req.node) });
      }
    }
    // Transitive selection counts every literal require() and import()
    // anywhere in the package, nested ones included.
    if (viaTransitive) {
      for (const call of moduleSourceCandidates(load.program, sf).calls) {
        const arg = call.arguments.nodes[0];
        if (
          arg !== undefined &&
          isStringLiteralLike(arg) &&
          (call.expression.kind === SyntaxKind.ImportKeyword ||
            (isIdentifier(call.expression) && call.expression.text === "require"))
        )
          edges.push({ spec: arg.text, loc: locOf(call) });
      }
    }
    for (const { spec, loc } of edges) {
      if (load.externalTypes?.has(spec)) continue;
      // scriptc's own packages are not npm dependencies: contract types are
      // declarations only, and @scriptc/threads and @scriptc/experimental
      // exports lower at their use sites (threads-import.ts,
      // experimental-import.ts), typed by their declarations.
      if (
        spec === CONTRACT_TYPES_MODULE ||
        spec === THREADS_MODULE ||
        spec === EXPERIMENTAL_MODULE ||
        spec === NODE_API_MODULE
      )
        continue;
      // Attested entries already resolve to program sources, so the
      // published package's declaration eligibility does not apply.
      if (provenanceEntryFor(spec) !== null) continue;
      // Packages scriptc implements itself, or that the project marks never
      // loaded, are not npm dependencies (package-shims.ts).
      if (isShimmedImport(sf.fileName, spec)) continue;
      if (resolveWorkspaceSourceModule(sf.fileName, spec) !== null) continue;
      if (isRelativeSpecifier(spec) || spec.startsWith("node:") || spec.startsWith("#")) continue;
      // Bare builtin names ("fs", "path") are the builtin machinery's
      // business (and the SC4005 async_free gate's, in library mode) —
      // never npm candidates. Auto keeps its original path (the
      // @types/node answer skips them below), unchanged.
      if (mode === "lib" && canonicalBuiltinModule(spec) !== null) continue;
      // npm packages served as builtins (graceful-fs as fs) never compile
      // their JavaScript.
      if (npmBuiltinAliasOf(spec) !== null) continue;
      // Explicit attempts name the runtime package. Types-first resolution
      // may instead identify its @types twin, which has no runtime to admit.
      if (judged?.has(packageNameOfSpecifier(spec))) continue;
      const npm = resolveNpmImport(sf.fileName, spec);
      if (npm !== null && isNodeTypesPath(npm.typesFile)) continue;
      // The runtime package Node loads. Types-first resolution answers an
      // @types twin's declarations for a package that ships none, but
      // selection and every refusal name the package that has the code.
      const js =
        mode === "lib" && (npm === null || npm.packageName.startsWith("@types/"))
          ? resolveBareModule(sf.fileName, spec, "js-only")
          : null;
      const runtimePkg = js !== null && js.packageName !== npm?.packageName ? js.packageName : null;
      if (npm === null || runtimePkg !== null) {
        if (mode !== "lib" || runtimePkg === null || judged!.has(runtimePkg)) continue;
        judged!.add(runtimePkg);
        sites!.set(runtimePkg, loc);
        if (viaTransitive) {
          transitive.add(runtimePkg);
          chosen.push(runtimePkg);
          continue;
        }
        // Both answers compile the JavaScript with inferred types; the
        // declarations only check the importer, and an inferred surface
        // the program does not typecheck against still refuses the package
        // below. A DefinitelyTyped twin qualifies; a package without
        // declarations qualifies as a dependency of another package, whose
        // JavaScript importer has no declarations to check.
        const refusal =
          npm === null
            ? owner === null && !sf.fileName.includes("/node_modules/")
              ? "it ships no own .d.ts declaration surface"
              : null
            : definitelyTypedMismatch(runtimePkg, npm.typesFile);
        if (refusal === null) {
          chosen.push(runtimePkg);
          continue;
        }
        statuses.push({
          package: runtimePkg,
          status: "refused",
          detail: refusal,
          hint: npmStaticOptInHint(runtimePkg, owner),
        });
        continue;
      }
      if (judged?.has(npm.packageName)) continue;
      // An @types twin with no runtime package installed has nothing to
      // compile (Node cannot load it either).
      if (viaTransitive && !npm.packageName.startsWith("@types/")) {
        judged!.add(npm.packageName);
        sites!.set(npm.packageName, loc);
        transitive.add(npm.packageName);
        chosen.push(npm.packageName);
        continue;
      }
      if (!seen.has(npm.packageName)) {
        seen.set(npm.packageName, { typesFile: npm.typesFile, fromFile: sf.fileName, spec, owner });
        sites?.set(npm.packageName, loc);
      }
    }
  }
  for (const [pkg, { typesFile, fromFile, spec, owner }] of seen) {
    judged?.add(pkg);
    // A package without a root entry (no "main", "exports" or index file)
    // can still serve the subpath the program imports.
    const jsEntry =
      resolveBareModule(fromFile, pkg, "js-only") ?? resolveBareModule(fromFile, spec, "js-only");
    const reason = npmStaticIneligibleReason(
      pkg,
      typesFile,
      jsEntry !== null && isJsSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null,
      mode === "lib" && isJsSourceFileName(typesFile) && fromFile.includes("/node_modules/"),
    );
    if (reason === null) chosen.push(pkg);
    else
      statuses.push({
        package: pkg,
        status: "refused",
        detail: mode === "lib" ? reason : `auto: ${reason}`,
        // Naming a package bypasses the declaration and shipped-JS
        // heuristics; it cannot supply JavaScript that does not resolve.
        ...(mode === "lib" && jsEntry !== null ? { hint: npmStaticOptInHint(pkg, owner) } : {}),
      });
  }
  return chosen;
}

/** How to compile a package the declaration bar refused anyway: name it,
 * or (for a dependency of an opted-in package) opt in that package's
 * whole dependency closure. */
function npmStaticOptInHint(pkg: string, importer: string | null): string {
  return importer === null
    ? `to compile it anyway, name it with --npm-static=${pkg} (or --npm-static=${pkg}... to include its dependencies)`
    : `to compile it anyway, name it with --npm-static=${pkg}, or use --npm-static=${importer}... to include all of ${importer}'s dependencies`;
}

/** The opted-in packages a consumer-anchored tsc message NAMES: module
 * specifiers in `Module '"spec"'` phrasings, and resolved file paths in
 * `import("…")` type spellings — the two ways the checker points at an
 * import surface from the importer's side. */
function packagesNamedByDiag(message: string, optedIn: ReadonlySet<string>): Set<string> {
  const hits = new Set<string>();
  for (const m of message.matchAll(/Module '"([^"]+)"'/g)) {
    const spec = m[1]!;
    const prefix = packageNameOfSpecifier(spec);
    if (optedIn.has(prefix)) hits.add(prefix);
  }
  for (const m of message.matchAll(/import\("([^"]+)"\)/g)) {
    const pkg = npmStaticPackageOfPath(m[1]!);
    if (pkg !== null && optedIn.has(pkg)) hits.add(pkg);
  }
  return hits;
}

/** The modules of packages the drop-and-reload loop is about to remove,
 * scanned on the program that still holds them. Report-only: a detector
 * failure here never changes the build's outcome. */
function scanDroppedPackages(
  load: LoadResult,
  packages: readonly string[],
  into: { modules: NodeIslandScan["modules"]; edges: NodeIslandScan["edges"] },
): void {
  if (packages.length === 0) return;
  try {
    const wanted = new Set(packages);
    const files = load.program.getImplementationSourceFiles().filter((sf) => {
      if (sf.isDeclarationFile) return false;
      const at = packageDirOf(sf.fileName);
      return at !== null && wanted.has(at.name);
    });
    const scanned = scanFiles(load.program, files, { userJs: false, dropped: true, edges: true });
    into.modules.push(...scanned.modules);
    into.edges.push(...scanned.edges);
  } catch {
    /* report-only detection */
  }
}

export function runFrontend(
  entryPath: string,
  loadProgram: ProgramLoader,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic: readonly string[] = [],
  nodeIslands: ReadonlySet<string> = new Set(),
): Frontend {
  // A preflight or package probe may throw after its host has opened. Track
  // only live loads, releasing each immediately on normal fallback; this
  // also closes both the current program and a failed temporary probe.
  const active: ReturnType<ProgramLoader>[] = [];
  const trackedLoader: ProgramLoader = (path, options) => {
    const load = loadProgram(path, options);
    active.push(load);
    return {
      ...load,
      dispose: () => {
        const index = active.indexOf(load);
        if (index < 0) return;
        active.splice(index, 1);
        load.dispose();
      },
    };
  };
  try {
    // Every executable and library closes over its dependencies. Explicit
    // selections bypass eligibility heuristics, but never compilation checks.
    const explicit: readonly string[] =
      npmStatic !== undefined && typeof npmStatic !== "string" ? npmStatic : [];
    // A trailing "..." (`--npm-static=fs-extra...`) selects the package and
    // its whole dependency closure, which the library fixpoint discovers.
    const transitive = new Set<string>();
    const names = [...libraryNpmStatic, ...explicit].map((name) => {
      if (!name.endsWith("...") || name.length === 3) return name;
      const base = name.slice(0, -3);
      transitive.add(base);
      return base;
    });
    setFrontendIslands(nodeIslands);
    try {
      return loadFrontend(
        entryPath,
        trackedLoader,
        "lib",
        externalTypes,
        [...new Set(names)].filter((name) => !nodeIslands.has(name)),
        transitive,
        nodeIslands,
      );
    } finally {
      setFrontendIslands(new Set());
    }
  } catch (error) {
    for (const load of active) {
      // Preserve the original failure and attempt every remaining cleanup.
      try {
        load.dispose();
      } catch {
        /* best effort after a failed load */
      }
    }
    throw error;
  }
}

function loadFrontend(
  entryPath: string,
  loadProgram: ProgramLoader,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic: readonly string[] = [],
  transitive: Set<string> = new Set(),
  nodeIslands: ReadonlySet<string> = new Set(),
): Frontend {
  // Resolver package/workspace metadata is intentionally shared across the
  // several load attempts of ONE auto-detection fixpoint, but never across
  // separate compiles in a long-lived process.  A cache miss must observe
  // package.json edits before it can publish a new early-library entry.
  clearResolveCaches();
  const statuses: NpmStaticStatus[] = [];
  const npmSites = new Map<string, SrcLoc>();
  // Node island detection (report-only): how each package was refused, and
  // the modules of packages removed from the program.
  const refusals: RefusalRecord[] = [];
  const droppedScan: { modules: NodeIslandScan["modules"]; edges: NodeIslandScan["edges"] } = {
    modules: [],
    edges: [],
  };
  const recordRefusal = (pkg: string, kind: RefusalKind, diag: ScrDiagnostic | null): void => {
    refusals.push({ package: pkg, kind, diag });
  };
  // Explicit library attempts bypass only the auto-selection heuristics.
  // The shared preflight/lowering refusal and dependency-closure checks remain.
  // Node island packages are judged already: they stay out of the
  // program, typed by their declarations (scope-B NI-4).
  const judged = new Set<string>([...libraryNpmStatic, ...nodeIslands]);
  let requested: string[] = [];
  let reusableScout: ReturnType<typeof loadProgram> | null = null;
  let reusablePreflight: ScrDiagnostic[] | null = null;
  if (npmStatic === "auto" || npmStatic === "lib") {
    const scout = loadProgram(entryPath, { externalTypes });
    let retained = false;
    try {
      const scoutPreflight = checkPreflight(scout);
      requested =
        npmStatic === "lib"
          ? [
              ...libraryNpmStatic,
              ...detectAutoPackages(scout, statuses, "lib", judged, npmSites, transitive),
            ]
          : detectAutoPackages(scout, statuses);
      // With no package to opt in, the scout already IS the final frontend:
      // same roots, resolution posture, preflight, and module order. Retain it
      // instead of spawning a second tsgo server and checking the whole graph
      // again — the common library-mode path has no bare npm imports.
      if (requested.length === 0) {
        reusableScout = scout;
        reusablePreflight = scoutPreflight;
        retained = true;
      }
    } finally {
      if (!retained) scout.dispose();
    }
  } else if (npmStatic !== undefined) {
    requested = [...new Set(npmStatic)];
  }

  // One exact --external-types mapping makes the containing package an
  // external host boundary, which cannot simultaneously be compiled as a
  // package-wide --npm-static program graph. External wins; retain the
  // npm-static refusal record so explicit and auto requests both
  // explain why the package did not compile statically.
  if (requested.length > 0 && externalTypes !== undefined) {
    const externalSpecifiersByPackage = new Map<string, string[]>();
    for (const specifier of Object.keys(externalTypes)) {
      const pkg = packageNameOfSpecifier(specifier);
      const specs = externalSpecifiersByPackage.get(pkg) ?? [];
      specs.push(specifier);
      externalSpecifiersByPackage.set(pkg, specs);
    }
    requested = requested.filter((pkg) => {
      const specs = externalSpecifiersByPackage.get(pkg);
      if (specs === undefined) return true;
      statuses.push({
        package: pkg,
        status: "refused",
        detail: `mapped as an external host module by --external-types (${specs.map((s) => JSON.stringify(s)).join(", ")})`,
      });
      recordRefusal(pkg, "external", null);
      return false;
    });
  }

  // Package-anchored preflight failures and attributable consumer errors
  // remove that package from the active source graph. Reloading restores
  // its declarations for analysis; the recorded refusal stops executable
  // and library builds with a package-specific diagnostic.
  let load = reusableScout ?? loadProgram(entryPath, { npmStatic: requested, externalTypes });
  let preflight = reusablePreflight ?? checkPreflight(load);
  // Library mode's fixpoint: the opted-in packages' files joined the
  // program just now, and THEIR bare edges (import statements and
  // top-level requires) name packages the scout could not see. Judge each
  // by the same bar — eligible ones join the set and the frontend
  // reloads; ineligible ones record a refusal. Bounded by the dependency
  // count (every iteration settles
  // at least one new package for good).
  if (npmStatic === "lib") {
    for (;;) {
      const grown = detectAutoPackages(load, statuses, "lib", judged, npmSites, transitive);
      if (grown.length === 0) break;
      requested = [...requested, ...grown];
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: requested, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  const effective = new Set(requested);
  // Packages refused only because the program does not typecheck against
  // their inferred surface (no offender, no package-anchored diagnostic).
  const typecheckRefused = new Set<string>();
  while (effective.size > 0) {
    const reasons = new Map<string, string>(npmStaticOffenders());
    const kinds = new Map<string, { kind: RefusalKind; diag: ScrDiagnostic | null }>();
    for (const pkg of reasons.keys()) kinds.set(pkg, { kind: "offender", diag: null });
    // Bundler interop the rewrite could not finish refuses its package
    // only where the compiled program can load the file.
    if (npmStaticFileDegrades().size > 0) {
      const loadable = npmStaticLoadableFiles(load.program, load.moduleOrder);
      for (const [file, { pkg, reason }] of npmStaticFileDegrades()) {
        if (!reasons.has(pkg) && (loadable === null || loadable.has(file))) {
          reasons.set(pkg, reason);
          kinds.set(pkg, { kind: "degrade", diag: null });
        }
      }
    }
    for (const d of preflight) {
      const pkg = npmStaticPackageOfPath(d.loc.file);
      if (pkg !== null && !reasons.has(pkg)) {
        reasons.set(pkg, `${d.code} at ${packageDiagWhere(load, d.loc)}: ${d.message}`);
        kinds.set(pkg, { kind: "preflight", diag: d });
      }
    }
    if (![...reasons.keys()].some((p) => effective.has(p))) {
      const named = new Map<string, number>();
      for (const d of preflight) {
        if (d.code !== "SC0001") continue;
        for (const pkg of packagesNamedByDiag(d.message, effective)) {
          named.set(pkg, (named.get(pkg) ?? 0) + 1);
        }
      }
      for (const [pkg, count] of named) {
        typecheckRefused.add(pkg);
        kinds.set(pkg, { kind: "typecheck", diag: null });
        reasons.set(
          pkg,
          `its inferred export surface breaks ${count} import site${count === 1 ? "" : "s"} in program files (bundler-emitted surfaces type only as far as inference reaches)`,
        );
      }
    }
    const dropping = [...reasons.keys()].filter((p) => effective.has(p));
    if (dropping.length === 0) break;
    scanDroppedPackages(load, dropping, droppedScan);
    for (const p of dropping) {
      effective.delete(p);
      statuses.push({ package: p, status: "refused", detail: reasons.get(p)! });
      const kind = kinds.get(p);
      recordRefusal(p, kind?.kind ?? "offender", kind?.diag ?? null);
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
    preflight = checkPreflight(load);
  }
  // The last resort, ALL modes: an opt-in can change the PROGRAM's OWN
  // typecheck through errors that name no package at all (declaration
  // shapes outside the safe overload projection — generic overloads,
  // declaration-only members, or a .d.ts type-GUARD an inferred JS
  // function cannot reproduce). Those SC0001s anchor in USER files no
  // offender or
  // message attribution reaches, so each remaining package is probed
  // ALONE-dropped (n is the opt-in count — a handful of extra analysis
  // loads); culprits whose removal clears the errors fall back with a
  // note, and if no subset typechecks, everything drops. Explicit opt-ins
  // degrade the same way — the ratified stance for bundle-shaped dists is
  // graceful per-package degradation, never a failed gate the user cannot
  // act on (the note carries the why).
  if (effective.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    const lastResortDropped: string[] = [];
    const dropWithNote = (p: string): void => {
      effective.delete(p);
      typecheckRefused.add(p);
      lastResortDropped.push(p);
      recordRefusal(p, "typecheck", null);
      statuses.push({
        package: p,
        status: "refused",
        detail:
          npmStatic === "auto"
            ? "auto: the program does not typecheck against its inferred surface"
            : npmStatic === "lib"
              ? "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)"
              : "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)",
      });
    };
    // Attribute per package by probing each SOLO (culprits are almost
    // always independent — each package's inferred surface breaks its own
    // import sites), then reload with the survivors; interaction effects
    // that still fail drop everything left.
    for (const p of [...effective]) {
      const probe = loadProgram(entryPath, { npmStatic: [p], externalTypes });
      const probeDiags = checkPreflight(probe);
      probe.dispose();
      if (probeDiags.some((d) => d.code === "SC0001")) dropWithNote(p);
    }
    scanDroppedPackages(load, lastResortDropped.splice(0), droppedScan);
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      scanDroppedPackages(load, lastResortDropped.splice(0), droppedScan);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
      preflight = checkPreflight(load);
    }
  }
  for (const p of requested) {
    if (effective.has(p)) statuses.push({ package: p, status: "static" });
  }
  // The final program types the refused packages by their own
  // declarations. If it still fails to typecheck, the type errors are the
  // program's, not the packages': report them at their own locations
  // instead of a package refusal that hides them.
  if (typecheckRefused.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    for (let i = statuses.length - 1; i >= 0; i--) {
      const s = statuses[i]!;
      if (s.status === "refused" && typecheckRefused.has(s.package)) statuses.splice(i, 1);
    }
  }

  const finalLoad = load;
  // An unknown key or value in the project's scriptc configuration fails
  // the build before anything else (SC8004).
  const projectConfig = readProjectConfig(entryPath);
  const configDiagnostics = projectConfig.diagnostics;
  return {
    preflight: configDiagnostics.length > 0 ? [...configDiagnostics, ...preflight] : preflight,
    entryText: () => finalLoad.entry.text,
    entryExports: () => entryFunctionExports(finalLoad.entry),
    // The contract scans the PROGRAM's source files, not the runtime
    // module order: a type-only module (nothing but exported types) has no
    // runtime edge and never joins moduleOrder, yet its declarations are
    // contract surface. Declaration files (default libs, @types) stay out,
    // and so do statically-compiled npm packages' files: their .d.ts is
    // dropped by construction (inference types the bodies), so no npm
    // declaration can name a wire-contract type — the contract vocabulary
    // is authored program surface only, and a workspace-linked package's
    // shipped .ts must not smuggle same-name declarations into the type
    // table.
    entryContract: () =>
      entryContractFacts(
        finalLoad.entry,
        finalLoad.program
          .getImplementationSourceFiles()
          .filter((sf) => !sf.isDeclarationFile && npmStaticPackageOfPath(sf.fileName) === null),
      ),
    // Runtime evaluation order first, then any type-only program modules
    // (no runtime edge, so absent from moduleOrder — but they are contract
    // surface now, and the library identity hashes cover the WHOLE module
    // graph; the Map dedups by fileName). Statically-compiled npm modules
    // are in moduleOrder like any program module, so their bytes join the
    // library identity hashes (source_hash/build_id) — compiled code is
    // identity, whatever directory it came from.
    sourceTexts: () => {
      const texts = new Map<string, string>(
        [
          finalLoad.entry,
          ...finalLoad.moduleOrder,
          ...finalLoad.program.getImplementationSourceFiles().filter((sf) => !sf.isDeclarationFile),
        ].map((sf) => [sf.fileName, sf.text]),
      );
      // SC8004 diagnostics point into the project's package.json.
      if (
        configDiagnostics.length > 0 &&
        projectConfig.manifest !== null &&
        projectConfig.manifestText !== null
      )
        texts.set(projectConfig.manifest, projectConfig.manifestText);
      return texts;
    },
    lower: (opts) => {
      const lowered = lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, {
        ...opts,
        frontendServices: finalLoad.services,
        startupCrash: finalLoad.startupCrash ?? null,
        inlineRequireCycleCalls: finalLoad.inlineRequireCycleCalls,
        moduleEdges: finalLoad.moduleEdges,
        projectCheckJs: finalLoad.typeWorld?.projectCheckJs ?? false,
        externalTypes: finalLoad.externalTypes,
        externalTypeSpecifiersByFile: finalLoad.externalTypeSpecifiersByFile,
      });
      // The declaration-typed boundary's notes (SC6102) join the
      // performance warnings; they never fail a build.
      const notes = finalLoad.declBoundaryNotes;
      if (notes === undefined) return lowered;
      return { ...lowered, performance: [...notes, ...(lowered.performance ?? [])] };
    },
    npmStatic: statuses,
    npmImportSites: npmSites,
    nodeIslandScan: ({ userJs }) => {
      const files = new Set<SourceFile>([finalLoad.entry, ...finalLoad.moduleOrder]);
      addDynamicImportGraph(finalLoad, files);
      // Package edges matter only when the program has npm packages: one
      // that loads, one that was refused, or one judged and dropped.
      const npm =
        statuses.length > 0 ||
        droppedScan.modules.length > 0 ||
        [...files].some((sf) => sf.fileName.includes("/node_modules/"));
      const scanned = scanFiles(finalLoad.program, [...files], {
        userJs,
        dropped: false,
        edges: npm,
      });
      return {
        modules: [...droppedScan.modules, ...scanned.modules],
        edges: [...droppedScan.edges, ...scanned.edges],
        refusals,
      };
    },
    dispose: finalLoad.dispose,
  };
}
