/** Shared frontend orchestration. Hosts supply a program loader so Node
 * and native callers use the same npm selection, preflight and lowering. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import { entryFunctionExports, type EntryExportInfo } from "./lib-exports.js";
import { entryContractFacts, type ContractFacts } from "./lib-contract.js";
import {
  canonicalBuiltinModule,
  checkPreflight,
  isNodeTypesPath,
  locOf,
  requiresOf,
  resolveNpmImport,
  type LoadResult,
} from "./program.js";
import {
  npmStaticIneligibleReason,
  npmStaticOffenders,
  npmStaticPackageOfPath,
} from "./npm-static.js";
import { clearResolveCaches, resolveBareModule } from "./resolve.js";
import { isJsSourceFileName } from "./tsc-codes.js";
import { isRelativeSpecifier, packageNameOfSpecifier } from "./workspace-registry.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./lowering/lowerer.js";
import type { FrontendServices } from "./services.js";
import { isImportDeclaration, isExportDeclaration, isStringLiteral } from "./ts7/adapter.js";

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
  /** --npm-static: each requested (or auto-detected) package's outcome —
   * compiled statically, or fallen back with the first refusal reason. */
  npmStatic: NpmStaticStatus[];
  /** Library mode only (empty otherwise): each judged npm package's first
   * import site, the anchor for the SC4020 static-or-refuse teaching. */
  npmImportSites: ReadonlyMap<string, SrcLoc>;
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
) => Frontend;

/** --npm-static=auto (and library mode's mandatory twin): one throwaway
 * load finds every bare npm import the program's own modules make, then
 * the eligibility heuristics (npm-static.ts) pick the packages whose
 * shipped JS is worth attempting. Rejected candidates report their reason
 * so the coverage output says why auto skipped them.
 *
 * "lib" widens the scan to the STATIC-OR-REFUSE posture (a fallback
 * status is a build-stopping SC4020 there, never an island note):
 *   - opted-in packages' OWN files are scanned too — import statements
 *     and top-level requires alike — so runFrontend's fixpoint loop
 *     judges every bare edge the growing graph exposes (the executable
 *     lane leaves a package's deps to the island; the library lane has
 *     no island);
 *   - a bare specifier no TYPES resolution answers but whose runtime JS
 *     resolves (a package with no own .d.ts) is judged instead of
 *     skipped — it fails the bar by name, not as a generic import fence;
 *   - `judged` dedups across fixpoint iterations and `sites` records
 *     each package's first import site, the SC4020 anchor. */
function detectAutoPackages(
  load: LoadResult,
  statuses: NpmStaticStatus[],
  mode: "auto" | "lib" = "auto",
  judged?: Set<string>,
  sites?: Map<string, SrcLoc>,
): string[] {
  // package → the resolved types file AND the file whose import found it:
  // the runtime-JS probe below must resolve from the SAME importing file,
  // or a package visible only to a nested package.json realm (a pnpm
  // monorepo's packages/*/node_modules, unreachable from the entry's own
  // walk-up) answers "no runtime JS" for perfectly ordinary installs.
  const seen = new Map<string, { typesFile: string; fromFile: string }>();
  for (const sf of [...load.moduleOrder, load.entry]) {
    if (mode === "auto" && sf.fileName.includes("/node_modules/")) continue;
    const edges: { spec: string; loc: SrcLoc }[] = [];
    for (const stmt of sf.statements) {
      if (
        (isImportDeclaration(stmt) || isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier &&
        isStringLiteral(stmt.moduleSpecifier)
      ) {
        edges.push({ spec: stmt.moduleSpecifier.text, loc: locOf(stmt) });
      } else if (mode === "lib") {
        // CJS packages spell their dep edges as top-level requires; the
        // import-statement scan alone would miss every one of them.
        for (const req of requiresOf(stmt)) edges.push({ spec: req.spec, loc: locOf(req.node) });
      }
    }
    for (const { spec, loc } of edges) {
      if (isRelativeSpecifier(spec) || spec.startsWith("node:") || spec.startsWith("#")) continue;
      // Bare builtin names ("fs", "path") are the builtin machinery's
      // business (and the SC4005 async_free gate's, in library mode) —
      // never npm candidates. Auto keeps its original path (the
      // @types/node answer skips them below), byte-for-byte.
      if (mode === "lib" && canonicalBuiltinModule(spec) !== null) continue;
      // Explicit attempts name the runtime package. Types-first resolution
      // may instead identify its @types twin, which has no runtime to admit.
      if (judged?.has(packageNameOfSpecifier(spec))) continue;
      const npm = resolveNpmImport(sf.fileName, spec);
      if (npm !== null && isNodeTypesPath(npm.typesFile)) continue;
      if (npm === null) {
        if (mode !== "lib") continue;
        const js = resolveBareModule(sf.fileName, spec, "js-only");
        if (js === null || judged!.has(js.packageName)) continue;
        judged!.add(js.packageName);
        sites!.set(js.packageName, loc);
        statuses.push({
          package: js.packageName,
          status: "fallback",
          detail: "it ships no own .d.ts declaration surface",
        });
        continue;
      }
      if (judged?.has(npm.packageName)) continue;
      if (!seen.has(npm.packageName)) {
        seen.set(npm.packageName, { typesFile: npm.typesFile, fromFile: sf.fileName });
        sites?.set(npm.packageName, loc);
      }
    }
  }
  const chosen: string[] = [];
  for (const [pkg, { typesFile, fromFile }] of seen) {
    judged?.add(pkg);
    const jsEntry = resolveBareModule(fromFile, pkg, "js-only");
    const reason = npmStaticIneligibleReason(
      pkg,
      typesFile,
      jsEntry !== null && isJsSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null,
    );
    if (reason === null) chosen.push(pkg);
    else
      statuses.push({
        package: pkg,
        status: "fallback",
        detail: mode === "lib" ? reason : `auto: ${reason}`,
      });
  }
  return chosen;
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

/** The one frontend, three npm postures: `undefined`/explicit package
 * lists and `"auto"` are the executable lane's (--npm-static; fallback =
 * island). `"lib"` is library mode's mandatory auto twin — the same
 * eligibility bar and the same opt-in machinery, but every fallback
 * status the shared loops record becomes compileLibrary's SC4020
 * static-or-refuse teaching, and the detection closes over the opted-in
 * packages' own bare edges (no island exists to serve a dep from). */
export function runFrontend(
  entryPath: string,
  loadProgram: ProgramLoader,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  libraryNpmStatic: readonly string[] = [],
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
    return loadFrontend(entryPath, trackedLoader, npmStatic, externalTypes, libraryNpmStatic);
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
): Frontend {
  // Resolver package/workspace metadata is intentionally shared across the
  // several load attempts of ONE auto-detection fixpoint, but never across
  // separate compiles in a long-lived process.  A cache miss must observe
  // package.json edits before it can publish a new early-library entry.
  clearResolveCaches();
  const statuses: NpmStaticStatus[] = [];
  const npmSites = new Map<string, SrcLoc>();
  // Explicit library attempts bypass only the auto-selection heuristics.
  // The shared preflight/lowering refusal and dependency-closure checks remain.
  const judged = new Set<string>(libraryNpmStatic);
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
          ? [...libraryNpmStatic, ...detectAutoPackages(scout, statuses, "lib", judged, npmSites)]
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
  // ordinary npm-static fallback record so explicit and auto requests both
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
        status: "fallback",
        detail: `mapped as an external host module by --external-types (${specs.map((s) => JSON.stringify(s)).join(", ")})`,
      });
      return false;
    });
  }

  // The all-or-nothing fallback loop: a preflight diagnostic ANCHORED in
  // an opted-in package's files (an unsupported require form, a builtin
  // fence) — or an offender the resolution itself reported — drops that
  // package from the set and the whole frontend reloads without it, so
  // its import takes the ordinary island path. Static compilation of a
  // package must never turn a working --dynamic build into a build
  // failure.
  //
  // CONSUMER-anchored attribution (the second source): an opted-in
  // package whose inferred export surface breaks the typecheck reports at
  // its IMPORT SITES — errors in program files no path-shaped attribution
  // reaches, but whose MESSAGES name the package ("Module '"pkg"' has no
  // exported member", "typeof import("…/pkg/dist/index")"). Bundle-shaped
  // dists carry surfaces inference can only partly reach (type-only
  // re-exports have no JS value to chase), and the ratified behavior is
  // graceful PER-PACKAGE degradation: the named package drops to the
  // island with a note, never a failed gate. Explicit opt-ins degrade
  // exactly like auto's — "the user asked for these packages" buys the
  // attempt, not a broken build.
  let load = reusableScout ?? loadProgram(entryPath, { npmStatic: requested, externalTypes });
  let preflight = reusablePreflight ?? checkPreflight(load);
  // Library mode's fixpoint: the opted-in packages' files joined the
  // program just now, and THEIR bare edges (import statements and
  // top-level requires) name packages the scout could not see. Judge each
  // by the same bar — eligible ones join the set and the frontend
  // reloads; ineligible ones record the fallback status compileLibrary
  // refuses on. Bounded by the dependency count (every iteration settles
  // at least one new package for good).
  if (npmStatic === "lib") {
    for (;;) {
      const grown = detectAutoPackages(load, statuses, "lib", judged, npmSites);
      if (grown.length === 0) break;
      requested = [...requested, ...grown];
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: requested, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  const effective = new Set(requested);
  while (effective.size > 0) {
    const reasons = new Map<string, string>(npmStaticOffenders());
    for (const d of preflight) {
      const pkg = npmStaticPackageOfPath(d.loc.file);
      if (pkg !== null && !reasons.has(pkg)) reasons.set(pkg, `${d.code}: ${d.message}`);
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
        reasons.set(
          pkg,
          `its inferred export surface breaks ${count} import site${count === 1 ? "" : "s"} in program files${npmStatic === "lib" ? "" : " — the package serves from the island instead"} (bundler-emitted surfaces type only as far as inference reaches)`,
        );
      }
    }
    const dropping = [...reasons.keys()].filter((p) => effective.has(p));
    if (dropping.length === 0) break;
    for (const p of dropping) {
      effective.delete(p);
      statuses.push({ package: p, status: "fallback", detail: reasons.get(p)! });
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
    const dropWithNote = (p: string): void => {
      effective.delete(p);
      statuses.push({
        package: p,
        status: "fallback",
        detail:
          npmStatic === "auto"
            ? "auto: the program does not typecheck against its inferred surface"
            : npmStatic === "lib"
              ? "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)"
              : "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase) — the package serves from the island instead",
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
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: [...effective], externalTypes });
      preflight = checkPreflight(load);
    }
  }
  for (const p of requested) {
    if (effective.has(p)) statuses.push({ package: p, status: "static" });
  }

  const finalLoad = load;
  return {
    preflight,
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
    sourceTexts: () =>
      new Map<string, string>(
        [
          finalLoad.entry,
          ...finalLoad.moduleOrder,
          ...finalLoad.program.getImplementationSourceFiles().filter((sf) => !sf.isDeclarationFile),
        ].map((sf) => [sf.fileName, sf.text]),
      ),
    lower: (opts) =>
      lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, {
        ...opts,
        frontendServices: finalLoad.services,
        startupCrash: finalLoad.startupCrash ?? null,
        externalTypes: finalLoad.externalTypes,
        externalTypeSpecifiersByFile: finalLoad.externalTypeSpecifiersByFile,
      }),
    npmStatic: statuses,
    npmImportSites: npmSites,
    dispose: finalLoad.dispose,
  };
}
