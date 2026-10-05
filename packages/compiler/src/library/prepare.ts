import { dirname, resolve } from "node:path";
import type { CompileFailure } from "../compile-types.js";
import { fenceSpeculativeWasiFunctions, moduleWasiUnavailableSurface, targetRefusalDiag } from "../backend/target-diagnostics.js";
import { checkerPanicDiag, libAsyncExportDiag, libAsyncSurfaceDiag, libExportUnresolvedDiag, libGenericExportDiag, libIntBoundaryDiag, libNpmIneligibleDiag, libSidecarDiag, libUnmappableSignatureDiag, iceDiag, isCheckerPanic, LIB_INBOUND_BYTES_TRAP_CODE, LIB_RUNTIME_TRAP_CODES, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { checkLibraryIntegerSlots, classSeed, hasIntSlots, numberCarrierKind, type FnIntSlots, type IntSlotConfig } from "./int-infer.js";
import { profileRemediation, profileTeaching, type LibraryProfile } from "./library-profile.js";
import { decorateLibraryRefusals, evaluateLibraryFences } from "./fence-eval.js";
import { assembleTrapTeaching } from "./trap-teaching.js";
import { buildSidecar, canonicalModuleGraph, canonicalPath, libraryIdentityHashes, type SidecarIntegerSlotFacts, type SidecarIrRecordPattern, type SidecarIrTypePattern } from "./sidecar.js";
import { validateSidecar } from "./sidecar-validate.js";
import type { EntryExportInfo } from "../frontend/lib-exports.js";
import type { ContractFacts } from "../frontend/lib-contract.js";
import type { LowerResult } from "../frontend/lowering/lowerer.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import { moduleLibAsyncSurface, moduleLibNondeterministicSurface, type IrFfiImport, type IrLibSection, type IrModule, type IrRecordShape, type IrType } from "../ir/ir.js";
import { validateModule } from "../ir/validate.js";

/** The marshalling-class fit over IR types (design §4.2 + the ratified
 * integer plumbing classes): number is every f64-backed class, bool/string
 * map directly, bytes is the u8 element kind. */
function libClassFits(cls: string, t: IrType): boolean {
  switch (cls) {
    case "bool":
      return t.kind === "bool";
    case "string":
    case "cstring":
      return t.kind === "string";
    case "bytes":
      return t.kind === "bytes" && t.elem === "u8";
    default: // f64 and the u8/u32/i32 plumbing classes
      return t.kind === "f64";
  }
}

/** Resolve the profile's export map against the entry module — SC4002/
 * SC4004/SC4007 from the declaration facts, SC4003 from the lowered IR
 * signatures — and land the library section on the module. */
function resolveLibrarySection(
  profile: LibraryProfile,
  entryInfo: Map<string, EntryExportInfo>,
  mod: IrModule,
  entryPath: string,
): { lib: IrLibSection } | { diagnostics: ScrDiagnostic[] } {
  const diagnostics: ScrDiagnostic[] = [];
  const entryLoc = { file: entryPath, start: 0, end: 0 };
  const fnByName = new Map(mod.functions.map((f) => [f.name, f]));
  const exports: IrLibSection["exports"] = [];
  for (const e of profile.exports) {
    const info = entryInfo.get(e.export);
    if (info === undefined) {
      diagnostics.push(
        libExportUnresolvedDiag(e.export, "the entry module has no exported function declaration by that name", entryLoc),
      );
      continue;
    }
    if (info.generic) {
      diagnostics.push(libGenericExportDiag(e.export, info.loc));
      continue;
    }
    if (info.async || info.generator) {
      diagnostics.push(libAsyncExportDiag(e.export, info.async ? "async" : "generator", info.loc));
      continue;
    }
    const fn = fnByName.get(e.export);
    if (fn === undefined) {
      diagnostics.push(
        libExportUnresolvedDiag(e.export, "the export did not lower to a compiled function", info.loc),
      );
      continue;
    }
    if (fn.params.length !== e.params.length) {
      diagnostics.push(
        libUnmappableSignatureDiag(
          e.export,
          "signature",
          `has ${fn.params.length} parameter(s) but the profile declares ${e.params.length} marshalling class(es)`,
          info.loc,
        ),
      );
      continue;
    }
    let bad = false;
    e.params.forEach((cls, i) => {
      if (!libClassFits(cls, fn.params[i]!.type)) {
        bad = true;
        diagnostics.push(
          libUnmappableSignatureDiag(
            e.export,
            `parameter ${i + 1} ('${fn.params[i]!.name}')`,
            `has IR type '${fn.params[i]!.type.kind}', which does not fit the declared marshalling class '${cls}'`,
            info.loc,
          ),
        );
      }
    });
    if (e.returns === "void" ? fn.returnType.kind !== "void" : !libClassFits(e.returns, fn.returnType)) {
      bad = true;
      diagnostics.push(
        libUnmappableSignatureDiag(
          e.export,
          "the return",
          `has IR type '${fn.returnType.kind}', which does not fit the declared marshalling class '${e.returns}'`,
          info.loc,
        ),
      );
    }
    if (!bad) {
      const resolvedExport: IrLibSection["exports"][number] = {
        symbol: e.symbol,
        fnName: e.export,
        params: e.params,
        returns: e.returns,
      };
      if (e.params.includes("bytes")) {
        // The wrapper's one host-contract trap (an inbound bytes length
        // past the marshalling class's range) is assembled HERE, once, as
        // the structured trap-teaching message: the profile's teaching for
        // SC4012 (or the mode's default text), the code, the trapping
        // export's C symbol exactly as the host linked it, and the
        // profile's remediation when supplied — so the backend emits the
        // same bytes and the sink sees one canonical message.
        resolvedExport.inboundBytesTrap = assembleTrapTeaching(
          profileTeaching(profile, LIB_INBOUND_BYTES_TRAP_CODE) ??
            "scriptc: library inbound bytes length out of range\n",
          LIB_INBOUND_BYTES_TRAP_CODE,
          e.symbol,
          profileRemediation(profile, LIB_INBOUND_BYTES_TRAP_CODE),
        );
      }
      if (e.params.includes("i64") || e.params.includes("u64")) {
        // The sibling host-contract trap for inbound declared-integer
        // parameters (ask 4): a value past ±(2^53−1) cannot ride f64
        // exactly, and silent rounding is a coercion the author never
        // wrote. Same code (SC4012 — one host-contract story), same
        // assembly-once discipline.
        resolvedExport.inboundIntTrap = assembleTrapTeaching(
          profileTeaching(profile, LIB_INBOUND_BYTES_TRAP_CODE) ??
            "scriptc: library inbound integer parameter out of range\n",
          LIB_INBOUND_BYTES_TRAP_CODE,
          e.symbol,
          profileRemediation(profile, LIB_INBOUND_BYTES_TRAP_CODE),
        );
      }
      exports.push(resolvedExport);
    }
  }
  if (diagnostics.length > 0) return { diagnostics };
  // The runtime detected-trap overlay rows: one per family code the profile
  // declares teaching or remediation text for, in the registry family's
  // order. LLVM emits these rows as the program TU's overlay table,
  // which the runtime uses to assemble the sink message. (SC4012 stays compile-time
  // assembled into the wrapper's message above and never reaches the
  // funnel's assembly path.)
  const trapOverlays: IrLibSection["trapOverlays"] = [];
  for (const code of LIB_RUNTIME_TRAP_CODES) {
    const teaching = profileTeaching(profile, code);
    const remediation = profileRemediation(profile, code);
    if (teaching !== undefined || remediation !== undefined) {
      trapOverlays.push({
        code,
        ...(teaching !== undefined ? { teaching } : {}),
        ...(remediation !== undefined ? { remediation } : {}),
      });
    }
  }
  const lib: IrLibSection = {
      profileName: profile.name,
      prefix: profile.prefix,
      initSymbol: profile.initSymbol,
      sinkRegisterSymbol: profile.sinkRegisterSymbol,
      collectSymbol: profile.collectSymbol,
      resultResetSymbol: profile.resultResetSymbol,
      threadInstances: profile.instancePerThread,
      // Host-callback channels: declaration order is the runtime slot
      // assignment, and the unregistered-call trap text is assembled HERE,
      // once, for consistent constant bytes (a DETECTED
      // trap: the funnel classifies the "scriptc: library callback "
      // prefix as SC4025 and names the entry the host called — the entry
      // is runtime knowledge, so no compile-time SC4012-style assembly
      // can carry it). Both fields stay absent on callback-free profiles
      // (the byte-identity guarantee).

      exports,
      trapOverlays,
  };
  if (profile.callbacks.length > 0) {
    lib.callbackRegisterSymbol = profile.callbackRegisterSymbol!;
    lib.callbacks = profile.callbacks.map((cb, slot) => ({
      name: cb.name, slot, params: [...cb.params], returns: cb.returns,
      unregisteredTrap: `scriptc: library callback '${cb.name}' invoked before registration\n`,
    }));
  }
  return { lib };
}

/** The export map's integer-slot obligations (ask 4): i64/u64 params and
 * returns become declared boundary slots keyed `exports.<name>.params[i]`
 * / `exports.<name>.return`; the u8/u32/i32 plumbing classes contribute
 * their proven inbound shapes as parameter seeds (the wrapper's coercion
 * contract), tightening the intraprocedural analysis at zero declaration
 * cost. Sidecar-declared slots (record fields, msg arms, helper params
 * and returns) merge into the same config at sidecar build. */
function libraryIntSlotConfig(profile: LibraryProfile): IntSlotConfig {
  const cfg: IntSlotConfig = { fns: new Map(), records: new Map() };
  for (const e of profile.exports) {
    const params = e.params.map((c) => (c === "i64" || c === "u64" ? c : null));
    const ret = e.returns === "i64" || e.returns === "u64" ? e.returns : null;
    const paramSeeds = e.params.map((c) => (c === "u8" || c === "u32" || c === "i32" ? classSeed(c) : null));
    if (params.every((p) => p === null) && ret === null && paramSeeds.every((s) => s === null)) continue;
    const slots: FnIntSlots = {
      fnName: e.export,
      params,
      paramPaths: e.params.map((c, i) => (c === "i64" || c === "u64" ? `exports.${e.export}.params[${i}]` : null)),
      ret,
      retPath: ret !== null ? `exports.${e.export}.return` : null,
      paramSeeds,
    };
    cfg.fns.set(e.export, slots);
  }
  return cfg;
}

/** Match the sidecar syntax's exact structural type projection against the
 * frontend's interned IR registries. The pattern deliberately mirrors
 * ShapeRegistry's identity: every field name and recursively mapped field
 * type participates. Tagged payload records additionally accept omission
 * of their `kind` field because the lowering may carry that discriminant
 * only in the surrounding union tag. */
function sidecarRecordMatcher(
  mod: IrModule,
): (pattern: SidecarIrRecordPattern, shape: IrRecordShape) => boolean {
  const records = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const unions = new Map((mod.unions ?? []).map((union) => [union.id, union]));

  const recordMatches = (
    pattern: SidecarIrRecordPattern,
    shape: IrRecordShape,
  ): boolean => {
    if (shape.tuple === true || shape.indexValue !== undefined) return false;
    const variants = [pattern.fields];
    if (pattern.kindMayBeOmitted === true) {
      variants.push(pattern.fields.filter((field) => field.name !== "kind"));
    }
    return variants.some(
      (fields) =>
        fields.length === shape.fields.length &&
        fields.every((field) => {
          const actual = shape.fields.find((candidate) => candidate.name === field.name);
          return actual !== undefined && typeMatches(field.type, actual.type);
        }),
    );
  };

  const unionMatches = (
    patterns: SidecarIrTypePattern[],
    actual: IrType[],
  ): boolean => {
    if (patterns.length !== actual.length) return false;
    const used = new Set<number>();
    const visit = (index: number): boolean => {
      if (index === patterns.length) return true;
      for (let i = 0; i < actual.length; i++) {
        if (used.has(i) || !typeMatches(patterns[index]!, actual[i]!)) continue;
        used.add(i);
        if (visit(index + 1)) return true;
        used.delete(i);
      }
      return false;
    };
    return visit(0);
  };

  const typeMatches = (
    pattern: SidecarIrTypePattern,
    actual: IrType,
  ): boolean => {
    switch (pattern.kind) {
      case "f64":
      case "string":
      case "bool":
      case "nullT":
      case "undefinedT":
      case "dyn":
        return actual.kind === pattern.kind;
      case "bytes":
        return actual.kind === "bytes" && actual.elem === pattern.elem;
      case "array":
        return actual.kind === "array" && typeMatches(pattern.elem, actual.elem);
      case "record": {
        if (actual.kind !== "record") return false;
        const shape = records.get(actual.shapeId);
        return shape !== undefined && recordMatches(pattern, shape);
      }
      case "union": {
        if (actual.kind !== "union") return false;
        const union = unions.get(actual.unionId);
        return union !== undefined && unionMatches(pattern.arms, union.arms);
      }
    }
  };

  return (pattern, shape) => recordMatches(pattern, shape);
}

/** Merge the sidecar-resolved integer slots (ask 4) into the inference
 * config: helper slots key by function name and IR parameter index (the
 * projection already shifted past the model receiver); record-field
 * slots map onto every interned IR shape whose complete structural field
 * signature matches the projected record's. Shapes intern structurally,
 * so a same-shaped second type shares the obligation. DECLARED paths with
 * the same class coalesce while retaining every source path for verdicts;
 * differing classes refuse because one lowered field cannot seed or check
 * two distinct class contracts without arm provenance. A
 * record fact that matches no shape binds nothing: no compiled code
 * constructs the type (the contract surface — init/update/subscriptions
 * and every helper — is force-lowered whenever integer slots are
 * declared, so this is genuine vacuity, not dead-stripping). */
function mergeSidecarIntSlots(
  cfg: IntSlotConfig,
  facts: SidecarIntegerSlotFacts,
  mod: IrModule,
): { ok: true; config: IntSlotConfig } | { ok: false; diagnostic: ScrDiagnostic } {
  const recordMatches = sidecarRecordMatcher(mod);
  for (const h of facts.helpers) {
    const fn = mod.functions.find((f) => f.name === h.fnName);
    const arity = Math.max(fn?.params.length ?? 0, (h.index ?? 0) + 1);
    let slots = cfg.fns.get(h.fnName);
    if (slots === undefined) {
      slots = {
        fnName: h.fnName,
        params: new Array<null>(arity).fill(null),
        paramPaths: new Array<null>(arity).fill(null),
        ret: null,
        retPath: null,
        paramSeeds: new Array<null>(arity).fill(null),
      };
      cfg.fns.set(h.fnName, slots);
    }
    if (h.kind === "param") {
      const i = h.index!;
      while (slots.params.length <= i) {
        slots.params.push(null);
        slots.paramPaths.push(null);
        slots.paramSeeds.push(null);
      }
      slots.params[i] = h.cls;
      slots.paramPaths[i] = h.path;
    } else {
      slots.ret = h.cls;
      slots.retPath = h.path;
    }
  }
  for (const r of facts.records) {
    for (const shape of mod.records ?? []) {
      if (!recordMatches(r.shape, shape)) continue;
      const target = shape.fields.find((f) => f.name === r.targetField);
      if (target === undefined || numberCarrierKind(target.type, mod) === null) continue;
      let m = cfg.records.get(shape.id);
      if (m === undefined) {
        m = new Map();
        cfg.records.set(shape.id, m);
      }
      const existing = m.get(r.targetField);
      if (existing !== undefined && existing.cls !== r.cls) {
        const paths = [
          ...existing.paths.map((path) => `'${path}' (${existing.cls})`),
          `'${r.path}' (${r.cls})`,
        ];
        return {
          ok: false,
          diagnostic: libSidecarDiag(
            `integer slots ${paths.join(" and ")} collapse to the same lowered record field '${r.targetField}' — their proof obligations cannot be kept distinct`,
            r.loc,
            "kind-tagged union arms and structurally identical records may share one lowered shape — same-class declarations coalesce, but differing classes require distinct structural shapes or at most one classified slot",
          ),
        };
      }
      if (existing === undefined) {
        m.set(r.targetField, { cls: r.cls, paths: [r.path] });
      } else if (!existing.paths.includes(r.path)) {
        existing.paths.push(r.path);
      }
    }
  }
  return { ok: true, config: cfg };
}

export interface PreparedLibrary {
  ok: true;
  mod: IrModule;
  sourceTexts: Map<string, string>;
  sidecarJson: string | null;
}

export function prepareLibrary(
  profile: LibraryProfile,
  profilePath: string,
  compilerVersion: string,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: (phase: string, detail?: Record<string, unknown>) => void = () => {},
): PreparedLibrary | CompileFailure {
  const entryPath = profile.entry;
  // Bare npm specifiers in a library graph take the STATIC-OR-REFUSE
  // posture: "lib" runs the same auto-detection and eligibility bar as
  // the executable lane's --npm-static (own .d.ts, unminified shipped JS,
  // no build-transform markers), automatically — the library path has no
  // island/dynamic tier to offer. Explicit profile npm_static entries may
  // also attempt source inference; any failed attempt remains a refusal.
  const fe = createFrontend(entryPath, "lib", undefined, profile.npmStatic);
  timing("frontend-load", {
    entry_bytes: fe.entryText().length,
    source_files: fe.sourceTexts().size,
  });
  let lowered: LowerResult;
  let sourceTexts: Map<string, string>;
  let entryInfo: Map<string, EntryExportInfo>;
  let contractFacts: ContractFacts | null;
  try {
    // Every library refusal leaves through the ask-5 teaching decoration:
    // profile text attaches by code, manifest id, or fence coverage as the
    // attributed note (the SC4004/SC4005 rider generalized).
    const fail = (diagnostics: ScrDiagnostic[]): CompileFailure => ({
      ok: false,
      diagnostics: decorateLibraryRefusals(diagnostics, profile),
      sourceTexts: fe.sourceTexts(),
    });
    // The npm verdicts FIRST: whatever the shared frontend would have
    // served from the island — an eligibility miss, an untyped install, a
    // preflight offender inside a package's files, a dropped inferred
    // surface — refuses here with the package and the specific bar it
    // missed. Checked before the general preflight, whose diagnostics for
    // these same imports speak executable-lane teachings (SC1010/SC0001 at
    // the unresolvable edge); the library answer is this one.
    const npmRefused = fe.npmStatic.filter((s) => s.status === "fallback");
    if (npmRefused.length > 0) {
      return fail(
        npmRefused.map((s) =>
          libNpmIneligibleDiag(
            s.package,
            // The one shared offender reason that narrates the executable
            // lane's fallback loses that clause here — no island exists on
            // this path to serve anything.
            (s.detail ?? "its static compilation was refused").replace("; the island serves the package", ""),
            fe.npmImportSites.get(s.package) ?? { file: entryPath, start: 0, end: 0 },
          ),
        ),
      );
    }
    if (fe.preflight.length > 0) return fail(fe.preflight);
    contractFacts = profile.sidecar !== null ? fe.entryContract() : null;
    // Ask 4, contract-surface reachability: when the sidecar declares ANY
    // integer slot, the designated init/update/subscriptions exports and
    // every contract helper (model-first exported function) seed lowering
    // too. They are attested surface — a declared record-field or msg-arm
    // class obligates EVERY write those bodies perform, and a declared
    // helper param is checked at their internal call sites — so the
    // attestation must cover COMPILED bodies, never a dead-stripped
    // vacuity (the bug this closes: a model-slot declaration whose only
    // writers were dead-stripped attested without any proof).
    const contractSurfaceRoots: string[] = [];
    if (profile.sidecar !== null && profile.sidecar.integerSlots.length > 0) {
      const sc = profile.sidecar;
      const fnNames = new Set(contractFacts!.functions.filter((f) => !f.generic).map((f) => f.name));
      for (const name of [sc.initExport, sc.updateExport, sc.subscriptionsExport]) {
        if (fnNames.has(name)) contractSurfaceRoots.push(name);
      }
      for (const fn of contractFacts!.functions) {
        if (fn.generic) continue;
        const first = fn.params[0];
        if (first !== undefined && first.shape !== null && first.shape.k === "ref" && first.shape.name === sc.model) {
          contractSurfaceRoots.push(fn.name);
        }
      }
    }
    // The profile's host-callback channels ride the FFI import machinery:
    // each channel is a signature-only ambient binding whose direct calls
    // lower to ffiCall nodes (the classes are a subset of the FFI's), and
    // `libraryCallbacks` flips the recognition to the library flavor —
    // SC4024 diagnostics, unused channels legal, undeclared references
    // refused with the callback teaching. The library lane never loads a
    // native-FFI manifest, so the channel set owns the surface outright.
    const cbImports: IrFfiImport[] = profile.callbacks.map((cb) => ({
      name: cb.name,
      symbol: cb.name,
      params: [...cb.params],
      returns: cb.returns,
    }));
    const integerSlotRoots: string[] = [];
    for (const slot of profile.sidecar?.integerSlots ?? []) {
      const name = /^helpers\.([^.]+)\.(?:params\[\d+\]|return)$/.exec(slot.slot)?.[1];
      if (name !== undefined) integerSlotRoots.push(name);
    }
    try {
      lowered = fe.lower({
        dynamic: false,
        targetPlatform: buildPlatform,
        ...(cbImports.length > 0 ? { ffiImports: cbImports } : {}),
        ...(cbImports.length > 0 ? { libraryCallbacks: true } : {}),
        // The profile-mapped exports are called from OUTSIDE the graph:
        // they seed reachability beside the entry's top level (an
        // executable build would dead-strip an uncalled export). A helper
        // with a declared integer slot (ask 4) seeds too: its attestation
        // must cover a COMPILED body, never a dead-stripped vacuity — the
        // sidecar advertises the slot's class, so the proof must exist.
        libRoots: [
          ...new Set([
            ...profile.exports.map((e) => e.export),
            ...integerSlotRoots,
            ...contractSurfaceRoots,
          ]),
        ],
      });
      timing("lower", {
        lib_roots: profile.exports.length + contractSurfaceRoots.length,
      });
    } catch (e) {
      if (!isCheckerPanic(e)) throw e;
      return fail([checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 })]);
    }
    if (lowered.module === null) return fail(lowered.diagnostics);
    entryInfo = fe.entryExports();
    sourceTexts = fe.sourceTexts();
  } finally {
    fe.dispose();
  }
  const mod = lowered.module!;
  timing("frontend-dispose");

  const fail = (diagnostics: ScrDiagnostic[]): CompileFailure => ({
    ok: false,
    diagnostics: decorateLibraryRefusals(diagnostics, profile),
    sourceTexts,
  });

  // Export resolution first (SC4002/SC4003/SC4004/SC4007 anchor at the
  // mapped declaration — a mapped async export reports as SC4004, not the
  // graph-wide gate), then the async_free requirement (ratified, SC4005),
  // then the profile's determinism fences (ask 5, SC4008) over the same
  // compiled graph the attestation scan reads: all refused before anything
  // is emitted, so the narrowed library link set below is structural fact.
  const resolved = resolveLibrarySection(profile, entryInfo, mod, entryPath);
  if ("diagnostics" in resolved) return fail(resolved.diagnostics);
  const asyncSurface = moduleLibAsyncSurface(mod);
  if (asyncSurface !== null) {
    return fail([libAsyncSurfaceDiag(asyncSurface.surface, asyncSurface.loc)]);
  }
  const fenced = evaluateLibraryFences(mod, profile);
  if (fenced.length > 0) return fail(fenced);
  mod.lib = resolved.lib;
  if (buildPlatform === "wasi") {
    fenceSpeculativeWasiFunctions(mod);
    const unavailable = moduleWasiUnavailableSurface(mod);
    if (unavailable !== null) return fail([targetRefusalDiag("wasm32-wasi", unavailable.surface, unavailable.loc)]);
  }

  // Ask 4's declared integer slots: the export map's i64/u64 classes
  // seed the config here; sidecar-declared slots (record fields, msg
  // arms, helper params/returns) merge in after the projection resolves
  // them below.
  let intCfg = libraryIntSlotConfig(profile);

  // The ask-2 contract sidecar rides the same invocation. Identity first
  // (schema §2's worked build_id definition over compiler version, profile
  // bytes, and the sorted canonical module graph; source_hash per the
  // profile's "module-graph" contract) — the u64 lands on the IR so native
  // archive assembly emits the identity getters from the ONE value the
  // sidecar records (V12's coherence by construction), then the projection into
  // the schema (declaration orders from the AST) and the V1–V14
  // self-check before anything is written.
  let sidecarJson: string | null = null;
  if (profile.sidecar !== null) {
    const rootDir = dirname(resolve(profilePath));
    const modules = canonicalModuleGraph(rootDir, sourceTexts);
    const { buildId, sourceHash } = libraryIdentityHashes(compilerVersion, profile.profileBytes, modules);
    mod.lib.identity = {
      buildIdSymbol: profile.sidecar.buildIdSymbol,
      abiVersionSymbol: profile.sidecar.abiVersionSymbol,
      buildId,
      abiVersion: profile.sidecar.abiVersion,
    };
    const built = buildSidecar({
      profile,
      facts: contractFacts!,
      compilerVersion: compilerVersion,
      entry: canonicalPath(rootDir, entryPath),
      buildId,
      sourceHash,
      deterministic: moduleLibNondeterministicSurface(mod) === null,
    });
    if (!built.ok) return fail(built.diagnostics);
    // Validate the serialized contract, including its omitted optional
    // properties, through the same checked-value path used by consumers.
    const violations = validateSidecar(JSON.parse(built.json));
    if (violations.length > 0) {
      // The projection above refuses every user-caused shape; a rule
      // violation surviving to here is an emitter bug.
      return fail(violations.map((v) => iceDiag(`sidecar self-check failed — ${v}`, { file: entryPath, start: 0, end: 0 })));
    }
    sidecarJson = built.json;
    const merged = mergeSidecarIntSlots(intCfg, built.integerSlotFacts, mod);
    if (!merged.ok) return fail([merged.diagnostic]);
    intCfg = merged.config;
  }
  timing("contract-sidecar", { source_files: sourceTexts.size });

  // Ask 4: the integer-boundary inference — every value that can reach a
  // profile-declared i64/u64 slot must PROVE representability, wholeness,
  // and range, or the build refuses with the failed obligation, the
  // observed evidence, and the author's fix (SC4021/SC4022/SC4023). Runs
  // only when at least one integer slot is declared; the sidecar (already
  // built above, written only on success) may then attest the classes —
  // §5's invariant that an attested integer class means the proof was
  // discharged holds because no artifact leaves this function otherwise.
  if (hasIntSlots(intCfg)) {
    const refusals = checkLibraryIntegerSlots(mod, intCfg).filter((v) => v.outcome === "refuse");
    if (refusals.length > 0) {
      return fail(refusals.map((v) => libIntBoundaryDiag(v.path, v.cls, v.obligation!, v.detail!, v.fix!, v.loc)));
    }
  }
  timing("integer-proof");

  const validation = validateModule(mod);
  if (validation.length > 0) return fail(validation.map((v) => iceDiag(v.message, v.loc)));
  timing("ir-validate");

  return { ok: true, mod, sourceTexts, sidecarJson };
}

export function libraryLocalizeSymbols(profile: LibraryProfile): string[] | undefined {
  return profile.localizeRuntime
    ? [
        profile.initSymbol,
        profile.sinkRegisterSymbol,
        ...(profile.collectSymbol !== null ? [profile.collectSymbol] : []),
        ...(profile.resultResetSymbol !== null ? [profile.resultResetSymbol] : []),
        ...(profile.callbackRegisterSymbol !== null ? [profile.callbackRegisterSymbol] : []),
        ...(profile.sidecar !== null
          ? [profile.sidecar.buildIdSymbol, profile.sidecar.abiVersionSymbol]
          : []),
        ...profile.exports.map((entry) => entry.symbol),
      ]
    : undefined;
}

export function libraryWasmExports(profile: LibraryProfile): string[] {
  return [
    profile.initSymbol, "scriptc_alloc", "scriptc_free",
    ...(profile.collectSymbol === null ? [] : [profile.collectSymbol]),
    ...(profile.resultResetSymbol === null ? [] : [profile.resultResetSymbol]),
    ...(profile.sidecar === null ? [] : [profile.sidecar.buildIdSymbol, profile.sidecar.abiVersionSymbol]),
    ...profile.exports.map((entry) => entry.symbol),
  ];
}

export function libraryWasmRefusal(profile: LibraryProfile, sanitize: boolean): ScrDiagnostic | null {
  const reserved = new Set(["scriptc_alloc", "scriptc_free", "memory", "_initialize", "_start"]);
  const symbols = [profile.initSymbol, profile.sinkRegisterSymbol, profile.collectSymbol, profile.resultResetSymbol,
    profile.callbackRegisterSymbol, ...profile.exports.map((entry) => entry.symbol), profile.sidecar?.buildIdSymbol, profile.sidecar?.abiVersionSymbol];
  const surface = sanitize ? "sanitized library builds"
    : profile.instancePerThread ? "thread-instanced libraries (instantiate separate Wasm instances instead)"
    : profile.localizeRuntime ? "runtime localization (Wasm instances already isolate their runtime)"
    : symbols.some((symbol) => symbol != null && reserved.has(symbol)) ? "library symbols reserved by the Wasm embedding ABI"
    : profile.callbacks.some((cb) => cb.name === "panic") ? "a callback named 'panic' (reserved by the Wasm embedding ABI)"
    : null;
  return surface === null ? null : targetRefusalDiag("wasm32-wasi", surface, { file: profile.entry, start: 0, end: 0 });
}
