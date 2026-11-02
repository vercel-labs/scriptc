import { readFileSync, realpathSync } from "node:fs";
import type { CompileFailure, CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { frontendDisposed } from "../frontend/dispose-hook.js";
import {
  checkerPanicDiag,
  nodeIslandEntryPatchDiag,
  nodeIslandEntryReadDiag,
  nodeIslandImplicitGlobalReadDiag,
  nodeIslandModuleNoteDiag,
  nodeIslandNoteDiag,
  nodeIslandReaderStripDiag,
  nodeIslandStripDiag,
  nodeIslandRetryFailedDiag,
  npmStaticRefusalDiag,
  nativePackageDiag,
  iceDiag,
  isCheckerPanic,
  stdioPatchAcrossIslandsDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { IrModule, SrcLoc } from "../ir/ir.js";
import { validateModule } from "../ir/validate.js";
import { checkContracts } from "../contracts/check.js";
import {
  fenceSpeculativeWasiFunctions,
  moduleWasiUnavailableSurface,
  targetRefusalDiag,
} from "../backend/target-diagnostics.js";
import type { LowerResult, LowerStats } from "../frontend/lowering/lowerer.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import type { UnitStore } from "../frontend/lowering/unit-reuse.js";
import type { CompilationTiming } from "../timing.js";
import { readProjectConfig } from "../project-config.js";
import {
  isMarkedUserModule,
  nodeIslandPolicy,
  type NodeIslandPolicy,
} from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import type { IslandModule, IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import {
  classifyDiagnostic,
  classifyMarker,
  isIslandReasonCode,
} from "../node-islands/classify.js";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import { describe } from "../node-islands/summary.js";
import { resolveBareModule } from "../frontend/resolve.js";
import type { NodeIslandScan } from "../node-islands/scan.js";
import { growIslandSet, type IslandGrowthContext } from "../node-islands/growth.js";
import type { NodeIslandMarker } from "../node-islands/detect.js";
import { isJsSourceFileName } from "../frontend/tsc-codes.js";

export interface PreparedExecutableModule {
  ok: true;
  mod: IrModule;
  sourceTexts: Map<string, string>;
  stats: LowerStats;
  /** Divergence warnings (SC6xxx): the build succeeds; these sites can
   * behave differently from Node. */
  warnings: ScrDiagnostic[];
  /** The Node islands the build ran (the SC8001 notes name them with their
   * reasons): packages by name, modules by file. A cached build repeats
   * them. */
  islands?: { packages: string[]; modules: string[] };
}

/** Release the parser/checker before native object generation begins.
 * `unitStore` keeps the lowered units of this build for the next one
 * (unit-reuse.ts). */
export function prepareExecutableModule(
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: CompilationTiming = () => {},
  lowerIslands: ReadonlyMap<string, IslandPackage> = new Map(),
  retryFences = true,
  unitStore: UnitStore | null = null,
  lowerModules: ReadonlyMap<string, IslandModule> = new Map(),
): PreparedExecutableModule | CompileFailure {
  // The island decision reads the detector's scan unless islands are off.
  const islandScan =
    nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands).mode !== "off";
  let fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, { islandScan });
  timing("frontend-load");
  // Node islands (scope-B NI-4): packages refused natively run in Node,
  // unless the policy says otherwise. The frontend reloads without them,
  // so their declarations type the program.
  const islandDecision = decideNodeIslands(entryPath, opts, fe, lowerIslands, lowerModules);
  // A patched builtin the native build cannot represent (an entry module
  // patch, or a native read of a patched member) fails here.
  if (islandDecision !== null && islandDecision.errors.length > 0) {
    const diagnostics = islandDecision.errors;
    const sourceTexts = fe.sourceTexts();
    fe.dispose();
    return { ok: false, diagnostics, sourceTexts };
  }
  if (islandDecision !== null) {
    fe.dispose();
    fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, {
      islandPackages: new Set(islandDecision.packages.keys()),
      ...(islandDecision.modules.size > 0
        ? { islandModules: new Set(islandDecision.modules.keys()) }
        : {}),
      islandScan,
    });
    timing("frontend-island-reload");
  }
  let lowered: LowerResult;
  let sourceTexts: Map<string, string>;
  let contractWarnings: ScrDiagnostic[] = [];
  let disposed = false;
  let fenceGrown: Map<string, IslandPackage> | null = null;
  const fenceSure = new Set<string>();
  // The growth inputs this build's frontend offers (node-islands/growth.ts).
  // Built once: the frontend does not change inside a build, and its scan is
  // a whole-program walk.
  let growthInputs: IslandGrowthContext | null = null;
  let growthBuilt = false;
  const growthOf = (): IslandGrowthContext | null => {
    if (!growthBuilt) {
      growthInputs = islandGrowth(entryPath, opts, fe);
      growthBuilt = true;
    }
    return growthInputs;
  };
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    const fail = (diagnostics: ScrDiagnostic[]): CompileFailure => ({
      ok: false,
      diagnostics,
      sourceTexts: fe.sourceTexts(),
    });

    const refused = fe.npmStatic.filter((entry) => entry.status === "refused");
    if (refused.length > 0) {
      return fail(
        refused.map((entry) =>
          npmStaticRefusalDiag(
            entry.package,
            entry.detail ?? "its static compilation was refused",
            fe.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 },
            entry.hint,
          ),
        ),
      );
    }
    if (fe.preflight.length > 0) {
      // An import of a natively compiled package that preflight refuses
      // in the importer (a CommonJS namespace import) is that package's
      // refusal: it runs in a Node island instead.
      const growth = growthOf();
      const grown =
        growth === null ? null : growIslandSet(growth, lowerIslands, { preflight: fe.preflight });
      if (grown !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          grown,
          retryFences,
          unitStore,
          lowerModules,
        );
      }
      return fail(fe.preflight);
    }

    try {
      lowered = fe.lower(
        {
          ...(islandDecision !== null ? { nodeIslands: islandDecision } : {}),
          targetPlatform: buildPlatform,
          ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
          ...(opts.tier !== undefined ? { tierMode: opts.tier } : {}),
          ...(unitStore !== null ? { unitStore } : {}),
        },
        (module) => validateModule(module).length === 0,
      );
      timing("lower");
    } catch (e) {
      // The last-resort panic fence: an upstream tsgo panic that crossed a
      // checker call no statement/collection fence wrapped still becomes a
      // clean failed compile (anchored at the entry), never a crashed CLI.
      if (!isCheckerPanic(e)) throw e;
      return fail([
        checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 }),
      ]);
    }
    if (lowered.module === null) {
      // Packages whose own modules refused to lower run in Node islands
      // too (the authoritative lowering, DESIGN.md §1.4): build again with
      // them as islands.
      const growth = growthOf();
      const grown =
        growth === null
          ? null
          : growIslandSet(growth, lowerIslands, { diagnostics: lowered.diagnostics });
      // Sloppy user modules the lowering refused join the same retry
      // (DESIGN.md note 1 §3.2): one reload with every island at once,
      // never one round per module.
      const grownModules = loweringModules(entryPath, opts, lowered.diagnostics, lowerModules);
      if (grown !== null || grownModules !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          grown ?? lowerIslands,
          retryFences,
          unitStore,
          grownModules ?? lowerModules,
        );
      }
      // A failed program whose compiled packages need the runtime or a
      // mutable object model (NI-2's report): try them as islands. If that
      // build fails too, its failure is the one reported. This build typed
      // those packages from their JavaScript, where the types they only
      // declare (interfaces, aliases such as `Static<T>`) are `any`, so its
      // diagnostics describe a program the island build does not compile:
      // there the packages' declarations type the user code.
      const marked =
        retryFences && growth !== null
          ? growIslandSet(growth, lowerIslands, {
              diagnostics: lowered.diagnostics,
              fences: lowered.runtimeFences,
              fenceMode: "report",
            })
          : null;
      if (marked !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          marked,
          false,
          undefined,
          lowerModules,
        );
      }
      return fail(lowered.diagnostics);
    }

    // A program that replaces a process output stream's write method has
    // nowhere to route an island's writes: the island's process.stdout is
    // its own object. Until islands share the native stream object (H2),
    // refuse the combination instead of silently missing the patch.
    if (islandDecision !== null && lowered.stdioPatches !== undefined) {
      return fail(lowered.stdioPatches.map((p) => stdioPatchAcrossIslandsDiag(p.stream, p.loc)));
    }

    const validation = validateModule(lowered.module);
    timing("ir-validate");
    if (validation.length > 0) {
      return fail(validation.map((v) => iceDiag(v.message, v.loc)));
    }
    if (buildPlatform === "wasi") {
      const entryLoc: SrcLoc = { file: entryPath, start: 0, end: 0 };
      if (opts.sanitize) {
        return fail([targetRefusalDiag("wasm32-wasi", "--sanitize", entryLoc)]);
      }
      if (ffi !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", "native FFI manifests", entryLoc)]);
      }
      fenceSpeculativeWasiFunctions(lowered.module);
      const unavailable = moduleWasiUnavailableSurface(lowered.module);
      if (unavailable !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", unavailable.surface, unavailable.loc)]);
      }
    }
    sourceTexts = fe.sourceTexts();
    if (lowered.contracts) {
      const checked = checkContracts(lowered.module, lowered.contracts, sourceTexts);
      timing("contracts");
      if (checked.diagnostics.length > 0) return fail(checked.diagnostics);
      if (checked.contracts) lowered.module.contracts = checked.contracts;
      contractWarnings = checked.warnings;
    }
    if (retryFences) {
      const growth = growthOf();
      fenceGrown =
        growth === null
          ? null
          : growIslandSet(growth, lowerIslands, {
              diagnostics: lowered.diagnostics,
              fences: lowered.runtimeFences,
              fenceMode: "sure",
              sure: fenceSure,
            });
    }
  } finally {
    if (!disposed) {
      fe.dispose();
      frontendDisposed();
      timing("frontend-dispose");
    }
  }

  const prepared: PreparedExecutableModule = {
    ok: true,
    mod: lowered.module!,
    sourceTexts,
    stats: lowered.stats,
    warnings: [
      ...(islandDecision?.notes ?? []),
      ...(fe.warnings ?? []),
      ...(lowered.divergences ?? []),
      ...(lowered.performance ?? []),
      ...contractWarnings,
    ],
    ...(islandDecision === null
      ? {}
      : {
          islands: {
            packages: [...islandDecision.packages.keys()].sort(),
            modules: [...islandDecision.modules.keys()].sort(),
          },
        }),
  };
  // Packages compiled with runtime fences that need the JavaScript
  // runtime or a mutable object model (fenceIslands): build again with
  // them as islands, and keep this build when that one cannot compile.
  // If that build fails, retry with only the packages whose fences fire
  // for sure (module-init or runtime fences); if that fails too, the native
  // build carries an SC8023 warning with the island build's first error,
  // never a silent fallback.
  if (fenceGrown !== null) {
    const attempts = [fenceGrown];
    const sure = new Map(
      [...fenceGrown].filter(([name]) => lowerIslands.has(name) || fenceSure.has(name)),
    );
    if (sure.size > lowerIslands.size && sure.size < fenceGrown.size) attempts.push(sure);
    let firstError: ScrDiagnostic | null = null;
    for (const islands of attempts) {
      const islanded = prepareExecutableModule(
        entryPath,
        opts,
        ffi,
        buildPlatform,
        createFrontend,
        timing,
        islands,
        false,
        unitStore,
        lowerModules,
      );
      if (islanded.ok) return islanded;
      firstError ??= islanded.diagnostics[0] ?? null;
    }
    if (firstError !== null) {
      const added = [...fenceGrown.keys()].filter((name) => !lowerIslands.has(name));
      prepared.warnings.push(
        nodeIslandRetryFailedDiag(added, firstError, { file: entryPath, start: 0, end: 0 }),
      );
    }
  }
  return prepared;
}

/** Whether two spellings name the same file (the checker resolves through
 * symlinks; a CLI argument may not). */
function sameFile(a: string, b: string): boolean {
  if (samePath(a, b)) return true;
  try {
    const real = realpathSync(a);
    const other = realpathSync(b);
    return samePath(real, other);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll("\\", "/") === b.replaceAll("\\", "/");
}

/** The pre-scan reasons that make a user module a sloppy-semantics island
 * by themselves (DESIGN.md note 1 §3.1): the constructs whose behavior
 * needs the JavaScript engine and that a syntax scan decides exactly, plus
 * the conservative `this` marker (decision S2). */
const SLOPPY_REASONS: ReadonlySet<string> = new Set([
  "with",
  "direct-eval",
  "annexb-block-function",
  "sloppy-this",
]);

/** A module that patches a builtin module's CommonJS object (the user's
 * decision, 2026-10-29): its patch is meant for code that shares Node's
 * builtin, so it runs in Node, where an island consumer sees it. */
const PATCH_REASONS: ReadonlySet<string> = new Set(["builtin-patch"]);

/** The program modules that run in Node islands, by file: modules marked
 * with `--node-island=<path>` or `scriptc.nodeIslands.modules`, and (under
 * `--node-islands=auto`) user JavaScript the pre-scan found a sloppy-only
 * construct in (decision S3). The entry stays native: a program whose entry
 * is an island runs the whole file in Node, which is a different feature. */
interface ModuleIslandDecision {
  modules: Map<string, IslandModule>;
  /** The entry module's own `builtin-patch` marker: the entry stays native
   * (a whole-file island is a different feature), so the build refuses it
   * with SC8006. */
  entryPatch: { file: string; marker: NodeIslandMarker } | null;
  /** User TypeScript modules with a `builtin-patch` marker that Node
   * cannot run with type stripping only (H3.5): SC8006, kept native. */
  stripProblems: { file: string; construct: string; loc: SrcLoc }[];
}

function moduleIslands(
  entryPath: string,
  policy: NodeIslandPolicy,
  scan: NodeIslandScan,
): ModuleIslandDecision {
  const modules = new Map<string, IslandModule>();
  let entryPatch: ModuleIslandDecision["entryPatch"] = null;
  const stripProblems: ModuleIslandDecision["stripProblems"] = [];
  for (const m of scan.modules) {
    if (m.origin !== "user") continue;
    const patches = m.markers.filter((marker) => PATCH_REASONS.has(marker.reason));
    // A TypeScript module islands only for a builtin patch (H3.2).
    if (!isJsSourceFileName(m.file) && patches.length === 0) continue;
    if (sameFile(m.file, entryPath)) {
      if (patches.length > 0 && entryPatch === null)
        entryPatch = { file: m.file, marker: patches[0]! };
      continue;
    }
    if (m.stripProblem !== null) {
      stripProblems.push({ file: m.file, ...m.stripProblem });
      continue;
    }
    const marked = isMarkedUserModule(policy, m.file);
    const sloppy = m.markers.filter((marker) => SLOPPY_REASONS.has(marker.reason));
    if (
      marked === null &&
      (policy.mode !== "auto" || (sloppy.length === 0 && patches.length === 0))
    )
      continue;
    const first = sloppy[0] ?? patches[0];
    const reason = first === undefined ? null : classifyMarker(first);
    modules.set(m.file, {
      file: m.file,
      class: reason === null ? "marked" : reason.class,
      reason:
        reason === null
          ? marked === "cli"
            ? "marked with --node-island"
            : 'marked "node" in scriptc.nodeIslands.modules'
          : describe(reason),
      decision: marked === null ? "auto" : "marked",
    });
  }
  return { modules, entryPatch, stripProblems };
}

/** The packages and modules a build runs in Node islands, or null for none:
 * under `--node-islands=auto` (the default) every npm package the native
 * pipeline refused plus the user modules the pre-scan found a sloppy
 * construct in, and packages marked `node`; under `explicit` only the
 * marked ones; under `off`, none (refusals stay SC2013). Each island is
 * reported once as an SC8001 note. */
function decideNodeIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  lowerIslands: ReadonlyMap<string, IslandPackage>,
  lowerModules: ReadonlyMap<string, IslandModule>,
): (NodeIslandSet & { notes: ScrDiagnostic[]; errors: ScrDiagnostic[] }) | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode === "off" || fe.nodeIslandScan === undefined) return null;
  // A package marked native stays refused: the build reports it rather
  // than running it in Node.
  const refused = new Set(
    policy.mode === "auto"
      ? fe.npmStatic
          .filter((e) => e.status === "refused" && !policy.forcedNative.has(e.package))
          .map((e) => e.package)
      : [],
  );
  for (const name of lowerIslands.keys()) refused.add(name);
  // The pre-scan's user-JavaScript markers exist only where a build may act
  // on them.
  const scan = fe.nodeIslandScan({ userJs: policy.mode === "auto" });
  const moduleDecision = moduleIslands(entryPath, policy, scan);
  const modules = moduleDecision.modules;
  // A sloppy write to an undeclared name creates a global — a sloppy-only
  // semantic the native tier does not implement, so the module runs in
  // Node (the user's policy, 2026-10-31). The checker decides this one, not
  // the syntax pre-scan: a write target needs bindings, and its sloppiness
  // depends on the enclosing function and file strictness. Preflight
  // reports it as SC1091 carrying the R2.4 reason. The entry stays native
  // (a whole-file island is a different feature), and a strict-mode write
  // is an ordinary lowering gap, so neither joins here.
  if (policy.mode === "auto") {
    for (const d of fe.preflight) {
      if (d.code !== "SC1091" || d.reason !== "implicit-global-write") continue;
      const file = d.loc.file;
      if (modules.has(file) || sameFile(file, entryPath)) continue;
      if (!isJsSourceFileName(file) || file.includes("/node_modules/")) continue;
      const reason = classifyDiagnostic(d, "refusal");
      modules.set(file, {
        file,
        class: reason.class,
        reason: describe(reason),
        decision: "auto",
      });
    }
  }
  // Modules the lowering refused keep their first reason (the reload no
  // longer compiles them).
  for (const [file, island] of lowerModules) if (!modules.has(file)) modules.set(file, island);
  const errors: ScrDiagnostic[] = [];
  if (moduleDecision.entryPatch !== null) {
    const { file, marker } = moduleDecision.entryPatch;
    errors.push(
      nodeIslandEntryPatchDiag(
        file,
        marker.member ?? marker.construct,
        builtinModuleOf(marker.member),
        marker.loc,
      ),
    );
  }
  for (const problem of moduleDecision.stripProblems)
    errors.push(nodeIslandStripDiag(problem.file, problem.construct, problem.loc));
  // Who else must see the patch (H3.4): every module that reads a patched
  // member through the builtin's CommonJS object joins the island set, npm
  // package or user module alike — the patch lives in the islands' Node, and
  // only sharing the builtin shows the read the patch, as in Node. The entry
  // stays native, and a user TypeScript module Node cannot strip cannot run
  // in Node at all: both are SC8006.
  const patchedMembers = new Map<string, string>();
  for (const m of scan.modules) {
    if (!modules.has(m.file)) continue;
    for (const marker of m.markers) {
      if (!PATCH_REASONS.has(marker.reason) || marker.member === undefined) continue;
      if (!patchedMembers.has(marker.member)) patchedMembers.set(marker.member, m.file);
    }
  }
  const readerPackages = new Map<
    string,
    { packageDir: string; member: string; patchFile: string }
  >();
  // A package the build marks native stays native: a read that only an
  // island could satisfy is SC8003, once per package and construct.
  const forcedNativeReads = new Set<string>();
  const readerModules = new Map<string, { member: string; patchFile: string }>();
  if (policy.mode === "auto" && patchedMembers.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.cjsReads) {
        const patchFile = patchFileOf(patchedMembers, read.member);
        if (patchFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (policy.forcedNative.has(m.packageName)) {
            const key = `${m.packageName}:${read.member}`;
            if (!forcedNativeReads.has(key)) {
              forcedNativeReads.add(key);
              errors.push(
                nativePackageDiag(
                  m.packageName,
                  `it reads '${read.member}' through the CommonJS ${builtinModuleOf(read.member)} object, which island module ${patchFile} patches; a native read cannot see the patch`,
                  fe.npmImportSites.get(m.packageName) ?? read.loc,
                ),
              );
            }
            continue;
          }
          if (!readerPackages.has(m.packageName) && !refused.has(m.packageName))
            readerPackages.set(m.packageName, {
              packageDir: m.packageDir,
              member: read.member,
              patchFile,
            });
        } else if (m.origin === "user") {
          if (sameFile(m.file, entryPath)) {
            errors.push(
              nodeIslandEntryReadDiag(
                m.file,
                read.member,
                builtinModuleOf(read.member),
                patchFile,
                read.loc,
              ),
            );
            continue;
          }
          if (m.stripProblem !== null) {
            errors.push(
              nodeIslandReaderStripDiag(
                m.file,
                read.member,
                patchFile,
                m.stripProblem.construct,
                m.stripProblem.loc,
              ),
            );
            continue;
          }
          if (!readerModules.has(m.file))
            readerModules.set(m.file, { member: read.member, patchFile });
        }
      }
    }
  }
  // Who else must see an implicit global (H3.4): a sloppy write creates the
  // name on Node's global object when its island module runs, and native
  // code has no global object to read it from. An npm package that reads
  // the name joins the island set (its Node sees the global); a user module
  // or the entry is SC8020.
  const readerGlobals = new Map<
    string,
    { packageDir: string; global: string; writerFile: string }
  >();
  const createdGlobals =
    policy.mode === "auto" ? implicitGlobalWrites(fe, modules) : new Map<string, string>();
  if (createdGlobals.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.globalReads) {
        const writerFile = createdGlobals.get(read.name);
        if (writerFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (policy.forcedNative.has(m.packageName)) {
            const key = `${m.packageName}:${read.name}`;
            if (!forcedNativeReads.has(key)) {
              forcedNativeReads.add(key);
              errors.push(
                nativePackageDiag(
                  m.packageName,
                  `it reads '${read.name}', which island module ${writerFile} creates as an implicit global; the native build has no global object, so the read cannot see it`,
                  fe.npmImportSites.get(m.packageName) ?? read.loc,
                ),
              );
            }
            continue;
          }
          if (!readerGlobals.has(m.packageName) && !refused.has(m.packageName))
            readerGlobals.set(m.packageName, {
              packageDir: m.packageDir,
              global: read.name,
              writerFile,
            });
        } else if (m.origin === "user") {
          errors.push(nodeIslandImplicitGlobalReadDiag(read.name, writerFile, read.loc));
        }
      }
    }
  }
  if (errors.length > 0) return { packages: new Map(), modules: new Map(), notes: [], errors };
  // A user module that reads a patched member runs in a Node island, so its
  // read goes through the patched object exactly as in Node (H3.4).
  for (const [file, reader] of readerModules) {
    modules.set(file, {
      file,
      class: "object-model",
      reason: `it reads '${reader.member}' through the CommonJS ${builtinModuleOf(reader.member)} object, which island module ${reader.patchFile} patches`,
      decision: "auto",
    });
  }
  if (
    refused.size === 0 &&
    policy.forcedNode.size === 0 &&
    modules.size === 0 &&
    readerPackages.size === 0 &&
    readerGlobals.size === 0
  )
    return null;
  const report = buildNodeIslandReport({
    entry: entryPath,
    scan,
    npm: fe.npmStatic,
    diagnostics: [],
    fences: [],
    policy,
  });
  const packages = new Map<string, IslandPackage>();
  const notes: ScrDiagnostic[] = [];
  const seen = new Set<string>();
  for (const island of report.islands) {
    if (island.path === null) continue;
    seen.add(island.package);
    if (!refused.has(island.package) && !policy.forcedNode.has(island.package)) continue;
    packages.set(island.package, {
      name: island.package,
      version: island.version,
      dir: island.path,
      class: island.class,
      reason: island.reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        island.package,
        island.version,
        island.class,
        island.reason,
        island.importedFrom[0] ??
          fe.npmImportSites.get(island.package) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // Refused packages the report has no installed directory for (refused
  // before they joined the program): their directory from the runtime
  // entry Node resolves.
  for (const name of refused) {
    if (packages.has(name) || lowerIslands.has(name)) continue;
    const site = fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 };
    const js =
      resolveBareModule(site.file, name, "js-only") ??
      resolveBareModule(site.file, name, "js-only", "require");
    const at = js === null ? null : packageDirOf(js.typesFile);
    if (at === null) continue;
    const status = fe.npmStatic.find((e) => e.package === name);
    packages.set(name, {
      name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: "packaging",
      reason: status?.detail ?? "its static compilation was refused",
    });
    notes.push(
      nodeIslandNoteDiag(name, packageVersionOf(at.dir), "packaging", status?.detail ?? "", site),
    );
  }
  // Packages islanded by their lowering refusals keep their first reason
  // (the reload no longer compiles them, so the scan has no reason).
  for (const [name, island] of lowerIslands) {
    if (seen.has(name) && packages.has(name)) {
      const kept = packages.get(name)!;
      if (kept.reason === "" || kept.class === "") packages.set(name, island);
      continue;
    }
    packages.set(name, island);
    notes.push(
      nodeIslandNoteDiag(
        island.name,
        island.version,
        island.class,
        island.reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // npm packages that read a patched member join the island set: their
  // patch lives in the island's Node, and only a shared builtin shows it.
  for (const [name, reader] of readerPackages) {
    if (packages.has(name)) continue;
    const version = packageVersionOf(reader.packageDir);
    const reason = `it reads '${reader.member}' through the CommonJS ${builtinModuleOf(reader.member)} object, which island module ${reader.patchFile} patches`;
    packages.set(name, {
      name,
      version,
      dir: reader.packageDir,
      class: "object-model",
      reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        name,
        version,
        "object-model",
        reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // npm packages that read an implicit global an island module creates join
  // the island set: the global lives on their Node's global object.
  for (const [name, reader] of readerGlobals) {
    if (packages.has(name)) continue;
    const version = packageVersionOf(reader.packageDir);
    const reason = `it reads '${reader.global}', the implicit global island module ${reader.writerFile} creates`;
    packages.set(name, {
      name,
      version,
      dir: reader.packageDir,
      class: "object-model",
      reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        name,
        version,
        "object-model",
        reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  for (const island of [...modules.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  ))
    notes.push(
      nodeIslandModuleNoteDiag(island.file, island.class, island.reason, {
        file: island.file,
        start: 0,
        end: 0,
      }),
    );
  return packages.size === 0 && modules.size === 0 ? null : { packages, modules, notes, errors };
}

/** The names the island modules' sloppy implicit-global writes create, each
 * with the file that creates it. Preflight reports each write as an SC1091
 * whose range is the write target. */
function implicitGlobalWrites(
  fe: ReturnType<FrontendFactory>,
  modules: ReadonlyMap<string, IslandModule>,
): Map<string, string> {
  const globals = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const d of fe.preflight) {
    if (d.code !== "SC1091" || d.reason !== "implicit-global-write") continue;
    const file = d.loc.file;
    if (!modules.has(file)) continue;
    let source = sources.get(file);
    if (source === undefined) {
      source = readFileSync(file, "utf8");
      sources.set(file, source);
    }
    const name = source.slice(d.loc.start, d.loc.end);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !globals.has(name)) globals.set(name, file);
  }
  return globals;
}

/** The builtin module a patched member belongs to ("fs" of
 * "fs.readFileSync"). */
function builtinModuleOf(member: string | undefined): string {
  if (member === undefined) return "";
  const end = /[.[]/.exec(member);
  return end === null ? member : member.slice(0, end.index);
}

/** The island module that patches `member`, matching an exact member or a
 * whole-module patch ("fs.*"). A read the scan cannot name ("fs.*", a
 * computed key or a rest element) matches every patch of its module, and so
 * does a patch through a computed key ("fs[…]"). */
function patchFileOf(patched: ReadonlyMap<string, string>, member: string): string | undefined {
  const module = builtinModuleOf(member);
  const exact = patched.get(member) ?? patched.get(`${module}.*`);
  if (exact !== undefined) return exact;
  const unnamedRead = member === `${module}.*`;
  for (const [patch, file] of patched) {
    if (builtinModuleOf(patch) !== module) continue;
    if (unnamedRead || patch.includes("[")) return file;
  }
  return undefined;
}

/** The growth inputs this build's frontend offers the shared island-growth
 * rules (node-islands/growth.ts), or null when the frontend holds no island
 * scan: the rules then grow nothing. `npmStatic` keeps a `"auto"` request
 * out: only an explicit list names the packages to keep native. */
function islandGrowth(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
): IslandGrowthContext | null {
  const scan = fe.nodeIslandScan?.({ userJs: false });
  if (scan === undefined) return null;
  return {
    entry: entryPath,
    policy: nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands),
    scan,
    npm: fe.npmStatic,
    npmImportSites: fe.npmImportSites,
    ...(Array.isArray(opts.npmStatic) ? { explicitNpmStatic: opts.npmStatic } : {}),
    sourceTexts: () => fe.sourceTexts(),
  };
}

/** The island modules grown by the lowering's refusals in user JavaScript
 * (`--node-islands=auto` only), or null when there are none: a sloppy
 * module whose semantics the native pipeline refuses (an implicit global,
 * a mapped `arguments`, a `with` the pre-scan could not decide) runs in
 * Node. One retry adds every one of them at once. */
function loweringModules(
  entryPath: string,
  opts: CompileRequestOptions,
  diagnostics: readonly ScrDiagnostic[],
  known: ReadonlyMap<string, IslandModule>,
): Map<string, IslandModule> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 16) return null;
  const grown = new Map(known);
  for (const d of diagnostics) {
    if (!isIslandReasonCode(d.code)) continue;
    const file = d.loc.file;
    // Packages run in Node through their own decision
    // (node-islands/growth.ts).
    if (file.includes("/node_modules/") || packageDirOf(file) !== null) continue;
    if (!isJsSourceFileName(file) || sameFile(file, entryPath)) continue;
    if (grown.has(file)) continue;
    const reason = classifyDiagnostic(d, "refusal");
    // A gap is a construct scriptc does not implement, not a sloppy
    // semantic: running it in Node would hide a compiler limitation.
    if (reason.class === "gap") continue;
    grown.set(file, {
      file,
      class: reason.class,
      reason: describe(reason),
      decision: "auto",
    });
  }
  return grown.size === known.size ? null : grown;
}
