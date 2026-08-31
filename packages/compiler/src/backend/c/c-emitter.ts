import { InternalCompilerError } from "../../errors.js";
/* IR → C. Three-address style: every IR expression lands in a fresh C temp.
 * Verbose (clang -O2 erases it) but buys three things: short-circuit
 * emission is trivially correct, reference counting has one mechanical
 * hook point, and the output shape is already close to a CFG lowering.
 *
 * RC ownership discipline (must match docs/ir.md):
 * - every refcounted temp (isRefCounted kinds) holds an owned (+1) reference;
 * - varDecl/assign/return/call-argument MOVE that ownership (the temp is
 *   struck from its release list); everything else borrows;
 * - each statement releases its remaining refcounted temps when it ends;
 * - each scope releases the refcounted locals declared in it when it exits;
 * - callees own their params and release them on exit (callers pass +1);
 * - `return` first releases pending temps and every in-scope refcounted
 *   local.
 *
 * RC dispatch is type-directed: frames and scopes carry {name, type} so a
 * release always knows which scr_*_release to call. `isRefCounted` in
 * ir.ts is the membership test — no `kind === "string"` checks here.
 *
 * The generated C is a debugging surface: locals keep their TS names inside
 * the mangled form and every statement carries a `source line` comment.
 */
import type {
  IrBytesElem,
  IrGlobal,
  IrRecordShape,
  IrExpr,
  IrFfiCallbackParamClass,
  IrFfiCallbackParam,
  IrFfiImport,
  IrFfiReleaseParam,
  IrFfiReturnClass,
  IrFfiValueParamClass,
  IrFunction,
  IrLocal,
  IrModule,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/ir.js";
import { ffiCallbackType, funcOf, isFfiCallbackParam, isFfiContextParam, isFfiReleaseParam, isRefCounted, isUnitType, mapOf, moduleEmbedsCompressedNpm, moduleUsesDgram, moduleUsesDynInvoke, moduleEmbedsBuiltin, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttp2, moduleUsesHttpServer, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesStream, moduleUsesTls, moduleUsesTlsCa, POINTER_KINDS, type PointerKind, RUNTIME_EMITTER_CLASS, STRING, VOID } from "../../ir/ir.js";
import { undefinedArmTag } from "../../ir/analysis.js";
import { allocateFfiCallbackAdapters, hasForeignFfiCallback, hasRetainedFfiCallback, type FfiCallbackAdapter } from "../ffi-callbacks.js";
import {
  mangleAsyncSpawn,
  mangleGenSpawn,
  mangleClassObj,
  mangleField,
  mangleGlobal,
  mangleFnClosure,
  mangleFunction,
  mangleLocal,
  mangleRawParam,
  mangleVtSlot,
  mangleWrapper,
} from "../mangle.js";
import { cFnPtrCast, cType, releaseCallC, cStringLiteral, cDecl } from "./types.js";
import { computeMayThrow } from "./may-throw.js";
import { unionTruthyHelper, unionEqHelper, unionToStrHelper, unionJoinHelper, jsonWriteHelper, jsonIndentHelper, dynMatchHelper, dynCheckHelper, dynFuncBoxHelper, dynToStrHelper, caughtToDynHelper, toDynHelper, recordKeyGetHelper, recordKeySetHelper } from "./walkers.js";
import { VtSlot, ClassMeta, emitStructDefs, vtEntriesFor, vtSlotParams, emitVtableDecls, emitVtableInstances, emitVtAdapterDefs, emitHierarchyClassHelpers, emitClassObjs, emitCtorThunkDefs, errorVtStampLines, emitterVtStampLines, streamVtStampLines, traceAdapterC, traceArgC, boxNewC, arrNewC } from "./shapes.js";
import { emitAsyncScaffolding, childDataThunkFor, childExitThunkFor, childExitSignalThunkFor, closeBindThunkFor, connectResThunkFor, connectSockThunkFor, closeOverrideWrapFor, dgramMsgThunkFor, dnsLookupThunkFor, fsRenameThunkFor, netLookupAnswerThunkFor, emitterInvokeThunkFor, streamCbThunkFor, streamDataThunkFor, raceAdapterFor, resolveThunkFor, sniAnswerThunkFor } from "./async.js";
import { emitNpmEmbedding, islandAdapter, islandTypedAdapter } from "./island.js";
import { emitFunction, emitBlock, emitStmts, emitStmt, emitTryCatch, emitSwitch, mergeBrace, emitBranchInto, emitCondition } from "./stmts.js";
import { emitExpr } from "./exprs.js";
import { emitLibraryIdentityLines } from "../library-identity-markers.js";

export interface CEmitOptions {
  /** Library archive assembly may move the volatile identity getters into a
   * separate translation unit. Public/direct emission keeps them by default. */
  emitLibraryIdentity?: boolean;
}

export function emitCModule(
  mod: IrModule,
  sourceText?: string,
  options: CEmitOptions = {},
): string {
  return new CEmitter(mod, sourceText, options).emit();
}

// Box construction moved onto CEmitter (boxNewC method): obj-kind boxes now
// also carry the payload type's trace entry point, which is type-directed
// through the emitter's cycle analysis.

/** A declared C value with its IR type — the unit frames and scopes track
 * so releases can be type-directed. */
export interface Temp {
  name: string;
  type: IrType;
}

type TruthyPointerType = Extract<IrType, {
  kind: Exclude<PointerKind, "string" | "union" | "dyn" | "jsval" | "caught">
}>;

/** A scope entry: a refcounted local, either held directly or through a
 * capture box (boxed locals release their BOX; the box frees its contents). */
export interface ScopeEntry extends Temp {
  boxed?: boolean;
}

function ffiNativeTypeC(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): string {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "uint8_t";
    case "u32":
      return "uint32_t";
    case "i32":
      return "int32_t";
    case "cstring":
      return "const char *";
    case "string":
    case "bytes":
      throw new InternalCompilerError(`emitter bug: span class '${cls}' has no scalar C type`);
    case "void":
      return "void";
  }
}

function ffiCallbackNativeParamsC(
  callback: IrFfiCallbackParam["callback"] | IrFfiReleaseParam["callback"],
  named: boolean,
): string[] {
  return callback.params.flatMap((param, i): string[] => {
    if (isFfiContextParam(param)) return [`void *${named ? "sc_ctx" : ""}`.trim()];
    if (param === "string" || param === "bytes") {
      return [
        `const uint8_t *${named ? `sc_a${i}` : ""}`.trim(),
        `size_t${named ? ` sc_a${i}_len` : ""}`,
      ];
    }
    return [`${ffiNativeTypeC(param)}${named ? ` sc_a${i}` : ""}`];
  });
}

function ffiCallbackPointerTypeC(
  callback: IrFfiCallbackParam["callback"] | IrFfiReleaseParam["callback"],
): string {
  const ret = ffiNativeTypeC(callback.returns);
  const params = ffiCallbackNativeParamsC(callback, false);
  return `${ret} (*)(${params.length > 0 ? params.join(", ") : "void"})`;
}

function ffiCallbackDummyC(callback: IrFfiCallbackParam["callback"]): string {
  return callback.returns === "void" ? "" : "0";
}

export class CEmitter {
  readonly lines: string[] = [];
  indent = 0;
  tempCounter = 0;
  /** Interned string literals: UTF-8 text → static symbol name. */
  readonly literals = new Map<string, string>();
  /** Kind-specialized typed-array access helpers actually used by this
   * program. Keeping these in the generated TU means unrelated binaries do
   * not pay even debug/link metadata for byte-loop fast paths. */
  readonly bytesElementHelpers = new Set<`${"get" | "set"}:${IrBytesElem}:${"f64" | "u64"}`>();
  /** Interned unit-armed union instances: "unionId:tag" → static symbol.
   * A unit arm (undefined/null) has no payload, so every instance of one
   * (union, tag) pair is identical — ONE immortal (rc == SIZE_MAX) static
   * serves them all. Immortals are skipped by retain/release and by the
   * cycle collector's child filter (SCR_CYC_SKIP), so the missing cycle
   * header is fine even when a traced container points at one. */
  readonly unitInstances = new Map<string, string>();
  /** Interned regex literals: "<flags>/<pattern>" → static symbol. One
   * immortal (rc == SIZE_MAX) ScrRegex per distinct (pattern, flags) pair —
   * the bytecode slot starts NULL and the runtime compiles it lazily on
   * first use. The source/flags strings ride the ordinary literal table. */
  readonly regexInstances = new Map<string, string>();
  /** Interned tagged-template strings objects: per-site key → symbol +
   * cooked spans. One immortal (rc == SIZE_MAX) ScrArr of interned string
   * literals per template-literal SITE — the spec's per-occurrence
   * identity: the same site evaluated twice hands the tag the same array,
   * two sites never share even with identical text. */
  readonly templateStringsInstances = new Map<string, { sym: string; cooked: string[] }>();
  /** Class objects (classes as first-class values): className → static
   * symbol. One immortal ScrClassObj per class some classRef names —
   * preorder interval baked as constants, the .name string in the literal
   * table, and a per-class construct thunk (void *sc_ct_*) newValue
   * dispatches through. Registered during body emission (the regex
   * pattern); the statics and thunks are assembled around the bodies. */
  readonly classObjs = new Map<string, string>();
  /** Stack of statement frames: refcounted temps not yet released or moved. */
  frames: Temp[][] = [];
  /** Stack of scopes: refcounted locals (with types) declared in each. */
  scopes: ScopeEntry[][] = [];
  /** The function being emitted: local table (for boxedness) and whether
   * each local arrived through the closure environment (env captures are
   * borrowed — never declared, never released here). */
  currentLocals = new Map<string, IrLocal>();
  captureIds = new Set<string>();
  /** Canonical byte-loop induction locals currently represented by an
   * unsigned integer shadow. Ordinary number reads widen the shadow back to
   * f64; direct byte indices consume it without a conversion round trip. */
  integerLoopBindings = new Map<string, string>();
  /** Declared functions referenced as values: each needs an env-signature
   * wrapper + an interned immortal closure (so `f === f` holds). */
  readonly fnValues = new Set<string>();
  /** Emitted ref-kind resolve thunks for new Promise, interned per inner
   * typeKey → thunk symbol. */
  readonly resolveThunks = new Map<string, string>();
  readonly genResThunks = new Map<string, string>();
  /** Emitted child exit adapters, interned per union id (childExitThunkFor). */
  readonly childExitThunks = new Map<string, string>();
  /** Emitted child-stream data adapters, interned per union id
   * (childDataThunkFor). */
  readonly childDataThunks = new Map<string, string>();
  /** Emitted bound-close adapters, interned per union id
   * (closeBindThunkFor). */
  readonly closeBindThunks = new Map<string, string>();
  /** Emitted close-override wrappers, interned per (union id, ret kind)
   * (closeOverrideWrapFor). */
  readonly closeOverrideWraps = new Map<string, string>();
  /** Emitted dgram message adapters, interned per rinfo shape id
   * (dgramMsgThunkFor). */
  readonly dgramMsgThunks = new Map<string, string>();
  /** Emitted dns.lookup callback adapters, interned per union id + param
   * count (dnsLookupThunkFor). */
  readonly dnsLookupThunks = new Map<string, string>();
  /** Emitted fs.rename callback adapters, interned per callback type. */
  readonly fsRenameThunks = new Map<string, string>();
  /** Emitted SNI answer-closure thunks, interned per cb func-type key
   * (sniAnswerThunkFor). */
  readonly sniAnswerThunks = new Map<string, string>();
  /** Emitted net.connect lookup answer thunks, interned per cb func-type
   * key (netLookupAnswerThunkFor). */
  readonly netLookupAnswerThunks = new Map<string, string>();
  /** Emitted EventEmitter listener invoke adapters, interned per listener
   * func-type key (emitterInvokeThunkFor). */
  readonly emitterInvokeThunks = new Map<string, string>();
  /** Emitted stream option-callback invoke adapters (read/write/final/
   * destroy/transform/flush — the leading-`this` closures), interned per
   * (kind, callback func-type) key (streamCbThunkFor). */
  readonly streamCbThunks = new Map<string, string>();
  /** Emitted stream completion-callback closure fns (the `callback` a
   * user's write/final/destroy/transform/flush receives and calls),
   * interned per (kind, done func-type) key (streamDoneFnFor). */
  readonly streamDoneFns = new Map<string, string>();
  /** Emitted CONNECT-listener union-socket adapters, interned per cb
   * func-type key (connectSockThunkFor). */
  readonly connectSockThunks = new Map<string, string>();
  /** Emitted Promise.race fulfillment adapters, interned per
   * `entryInner=>resultInner` typeKey pair (raceAdapterFor). */
  readonly raceThunks = new Map<string, string>();
  /** setTimeout appeared somewhere: main must run the event loop even in
   * programs with no async functions. */
  usesTimers = false;
  readonly fnByName = new Map<string, IrFunction>();
  /** Manifest-bound native imports, used by ffiCall emission. */
  readonly ffiByName = new Map<string, IrFfiImport>();
  /** One C-ABI trampoline per manifest callback entry. Raw function
   * pointers additionally get a distinct TLS context slot, so two
   * callbacks with the same signature never alias each other's closure. */
  readonly ffiCallbackAdapters: Map<string, FfiCallbackAdapter>;
  /** Module-level constant consulted per ffiCall: with a retained
   * descriptor anywhere in the manifest, every native call is a
   * pending-exception checkpoint (may-throw derives the same fact from
   * the same helper). */
  readonly ffiHasRetainedCallback: boolean;
  readonly ffiHasForeignCallback: boolean;
  readonly globalsById = new Map<string, IrGlobal>();
  readonly unionsById = new Map<string, IrUnionDef>();
  /** Active optional-chain bind temps, by chain id (chainRecv reads). */
  readonly chainTemps = new Map<string, Temp>();
  readonly recordsById = new Map<string, IrRecordShape>();
  /** Record shapes whose bodies emitted recordClone. Filled while function
   * bodies emit, before emitStructDefs assembles per-shape helpers. */
  readonly recordCloneShapes = new Set<string>();
  /** Type-directed JSON walkers, interned per typeKey — one serializer per
   * type used in jsonStringify position (sc_jw_*), one match predicate
   * (sc_dm_*) and one checked builder (sc_dc_*) per type used in dynCheck
   * position. Emitted as prototypes + definitions after the struct block
   * (they reference struct types, per-shape RC helpers, and each other, so
   * the prototypes make definition order irrelevant). */
  readonly jsonWriters = new Map<string, string>();
  /** The pretty-print re-indenter (type-independent, interned once):
   * emitted on the first `JSON.stringify(v, null, space)` site. */
  jsonIndentFn: string | null = null;
  /** The dyn ToString pair (type-independent, interned once): emitted on
   * the first String(unknown) / `${unknown}` site. */
  dynToStrFn: string | null = null;
  /** The caught→dyn converter (type-independent, interned once): emitted
   * on the first catch binding flowing into an `unknown` slot. */
  caughtToDynFn: string | null = null;
  /** Interned per-union helpers: unionId → emitted function name. */
  readonly unionTruthyFns = new Map<string, string>();
  readonly unionEqFns = new Map<string, string>();
  readonly unionToStrFns = new Map<string, string>();
  readonly unionJoinFns = new Map<string, string>();
  readonly dynMatchers = new Map<string, string>();
  readonly dynBuilders = new Map<string, string>();
  /** Static→dyn converters (sc_td_*), per typeKey; dynamic-keyed record
   * read helpers (sc_rkg_*), per shapeId|result typeKey; dynamic-keyed
   * write helpers (sc_rks_*), per shapeId. */
  readonly toDynFns = new Map<string, string>();
  /** ReadableStream.from typed-array element adapters, per element
   * typeKey. The runtime retains the original array and calls one of these
   * for each pull, preserving iterator-time reads without teaching the
   * runtime the compiler's program-specific record/union layouts. */
  readonly streamFromArrayAdapters = new Map<string, string>();
  /** Identity-preserving static→dyn capsules used by Web APIs whose values
   * remain directly observable (stream chunks and AbortSignal reasons). */
  readonly liveDynRefAdapters = new Map<
    string,
    { snapshot: string; commit: string }
  >();
  /** Runtime-arm dispatchers for live references whose static type is a
   * union. Mutable arms become typed capsules; scalar/unit arms retain the
   * ordinary static-to-dyn conversion. */
  readonly liveDynUnionRefAdapters = new Map<string, string>();
  readonly dynPromiseAdapters = new Map<string, string>();
  /** The checked-dynamic function boundary's per-signature helpers (see
   * walkers.ts): call thunks (sc_dfk_*), box builders (sc_dfb_*),
   * and dynCheck adapters (sc_dfa_*), each per func typeKey. */
  readonly dynFuncThunks = new Map<string, string>();
  readonly dynFuncBoxes = new Map<string, string>();
  readonly dynFuncAdapters = new Map<string, string>();
  /** dyn-promise settle adapters (sc_pda_*), per INNER typeKey: convert a
   * typed fulfillment payload into the boxed destination's dyn payload
   * (scr_dyn_new_promise_adapting's callback — toDynHelper's promise arm). */
  readonly promiseDynAdapters = new Map<string, string>();
  readonly recordKeyGetFns = new Map<string, string>();
  readonly recordKeySetFns = new Map<string, string>();
  readonly walkerProtos: string[] = [];
  readonly walkerDefs: string[] = [];
  /** Island host-call adapters, interned per (arity, void-ness): the one
   * uniform shape scr_jsval_from_closure calls — unpack the cell array,
   * call the closure through its real ABI (which CONSUMES its params, so
   * each cell is retained in), return the +1 result cell or NULL for void.
   * Definitions ride walkerDefs (self-contained over the closure ABI). */
  readonly islandAdapters = new Map<string, string>();
  /** TYPED island host-call adapters, interned per full signature (param
   * typeKeys + return classification): each incoming engine argument
   * converts to the param's static type through the exit machinery before
   * the closure runs — see islandTypedAdapter (island.ts). */
  readonly islandTypedAdapters = new Map<string, string>();
  /** Enclosing break/continue targets. An unlabeled `break` binds to the
   * innermost loop-or-switch entry (labeled BLOCK entries are skipped); an
   * unlabeled `continue` searches inward-out for the innermost LOOP,
   * skipping switches and blocks. A LABELED jump binds to the entry whose
   * `labels` contains its label: `break lbl` jumps to the target's
   * endLabel (loops allocate one lazily via `usedEnd` — a C `break` only
   * exits the innermost loop), `continue lbl` to the target loop's
   * continueLabel. Loops: `continueLabel` is null when C `continue` is
   * correct (unlabeled while/forOf); for/do-while loops need a goto label
   * so `continue` still runs the update/condition, and LABELED loops of
   * every shape allocate one up front (a labeled continue from a nested
   * loop needs a goto). Switches are emitted as goto chains — never as C
   * `switch` — so a C `break`/`continue` inside an emitted switch region
   * still binds to the enclosing C loop; a break targeting the switch
   * itself jumps to `endLabel` instead. Labeled blocks carry only an
   * endLabel (`break lbl` is the only jump that can target them).
   * `scopeDepth` = scopes.length at entry — a break/continue releases
   * every scope pushed after that before jumping. `frameDepth` =
   * frames.length at entry: statements the jump exits may still hold
   * pending refcounted temps in their frames (a switch's discriminant,
   * most notably), whose normal end-of-statement releases sit on the
   * fall-through path the jump bypasses — the jump releases every frame
   * pushed after the target's own before jumping. */
  jumpTargets: (
    | {
        kind: "loop";
        continueLabel: string | null;
        usedContinue: boolean;
        endLabel: string | null;
        usedEnd: boolean;
        labels?: string[];
        scopeDepth: number;
        frameDepth: number;
      }
    | { kind: "switch"; endLabel: string; usedEnd: boolean; labels?: string[]; scopeDepth: number; frameDepth: number }
    | { kind: "block"; endLabel: string; usedEnd: boolean; labels: string[]; scopeDepth: number; frameDepth: number }
  )[] = [];
  labelCounter = 0;
  readonly returnTypeByFn = new Map<string, IrType>();
  lineStarts: number[] | null = null;
  /** May-throw analysis results (computeMayThrow): pending-exception checks
   * are emitted only after calls that can actually raise. */
  readonly mayThrow: Set<string>;
  readonly indirectMayThrow: boolean;
  /** Enclosing try contexts, innermost last — the compile-time analogue of
   * the jump-target stack for UNWINDING: a pending check (or `throw`) inside
   * a try releases frames/scopes down to the recorded depths and jumps to
   * `label` (the catch, or the exception-path finally) instead of returning
   * out of the function. Purely compile-time: entering a try emits no code. */
  tryStack: { label: string; used: boolean; frameDepth: number; scopeDepth: number }[] =
    [];
  /** Enclosing try-with-FINALLY regions, innermost last — the pending-
   * return analogue of tryStack: a `return` inside one snapshots its value
   * into the function's pending-return slot (sc_pret), releases down to
   * the region's depths, and jumps to `label` (the region's pending-return
   * finally copy), whose tail dispatches to the next region out or emits
   * the actual return. Spans tryBody and catchBody; the finally body
   * itself is outside (the frontend fences jumps there). */
  finallyStack: { label: string; used: boolean; frameDepth: number; scopeDepth: number }[] =
    [];
  /** Return type of the function being emitted — the unwind path returns a
   * dummy of this type (never read: callers check the pending flag first). */
  currentReturnType: IrType = VOID;
  /** The generator channels of the function being emitted (null outside
   * generator bodies): yieldExpr emission reads them, and emitTryCatch's
   * catch prologue emits the GENRET sentinel re-unwind exactly here. */
  currentGenerator: { yieldT: IrType; nextT: IrType } | null = null;
  /** Cycle-capable shapes ("object:<name>" / "record:<id>") and unions
   * (unionId): instances get a cycle header + emitted trace/teardown, and
   * fields/payloads of these types are visited by container traces.
   * Computed as a greatest fixpoint in the constructor — see there. */
  readonly tracedShapes = new Set<string>();
  readonly tracedUnions = new Set<string>();
  /** The class graph (single inheritance): base/children links, hierarchy
   * membership (extends anywhere ⇒ vtable word + dynamic release), the
   * whole-program preorder numbering behind O(1) instanceof, and the
   * per-hierarchy virtual slot lists (root classes only). Computed once in
   * the constructor. */
  readonly classMeta = new Map<string, ClassMeta>();
  /** Method names with at least one may-throw implementation: a
   * virtualCall's pending check keys on this (same over-approximation as
   * computeMayThrow's callee cover). */
  readonly mayThrowMethods = new Set<string>();
  /** Vtable slot adapters to define after the function signatures (they
   * call sc_f_* bodies): dedupe key "implClass.method". */
  readonly vtAdapters = new Map<string, { impl: ClassMeta; slot: VtSlot }>();

  constructor(
    readonly mod: IrModule,
    sourceText?: string,
    private readonly options: CEmitOptions = {},
  ) {
    this.ffiCallbackAdapters = allocateFfiCallbackAdapters(mod.ffiImports ?? []);
    this.ffiHasRetainedCallback = hasRetainedFfiCallback(mod.ffiImports ?? []);
    this.ffiHasForeignCallback = hasForeignFfiCallback(mod.ffiImports ?? []);
    for (const fn of mod.functions) {
      this.returnTypeByFn.set(fn.name, fn.returnType);
      this.fnByName.set(fn.name, fn);
    }
    for (const entry of mod.ffiImports ?? []) {
      this.ffiByName.set(entry.name, entry);
    }
    const mt = computeMayThrow(mod);
    this.mayThrow = mt.fns;
    this.indirectMayThrow = mt.indirect;
    for (const g of mod.globals ?? []) this.globalsById.set(g.id, g);
    for (const u of mod.unions ?? []) this.unionsById.set(u.id, u);
    for (const r of mod.records ?? []) this.recordsById.set(r.id, r);
    // The class graph. Link base/children, number the forest in preorder
    // (roots and children in module class order — deterministic), and
    // compute each hierarchy's virtual slots: a class's method gets a slot
    // iff no ancestor declares it (root-most) AND some strict descendant
    // redeclares it — never-overridden methods stay direct calls
    // everywhere (whole-program devirtualization).
    for (const cls of mod.classes ?? []) {
      const meta: ClassMeta = {
        def: cls,
        base: null,
        children: [],
        root: undefined as unknown as ClassMeta,
        pre: 0,
        post: 0,
        hierarchy: false,
        slots: [],
      };
      this.classMeta.set(cls.name, meta);
    }
    for (const meta of this.classMeta.values()) {
      if (meta.def.base === undefined) continue;
      const base = this.classMeta.get(meta.def.base);
      if (!base) throw new InternalCompilerError(`emitter bug: undeclared base class ${meta.def.base}`);
      meta.base = base;
      base.children.push(meta);
    }
    let preCounter = 0;
    const number = (meta: ClassMeta, root: ClassMeta): void => {
      meta.root = root;
      meta.pre = preCounter++;
      for (const c of meta.children) number(c, root);
      meta.post = preCounter - 1; // max pre in the subtree (inclusive)
    };
    for (const meta of this.classMeta.values()) {
      if (meta.base === null) number(meta, meta);
      // The runtime emitter class is ALWAYS a hierarchy member: ScrEmitter
      // carries its vtable word whether or not the program subclasses it.
      meta.hierarchy = meta.base !== null || meta.children.length > 0 ||
        meta.def.name === RUNTIME_EMITTER_CLASS;
    }
    const declares = (m: ClassMeta, method: string): boolean =>
      m.def.methods?.includes(method) ?? false;
    const declaredBelow = (m: ClassMeta, method: string): boolean =>
      m.children.some((c) => declares(c, method) || declaredBelow(c, method));
    const collectSlots = (m: ClassMeta, root: ClassMeta, seen: Map<string, number>): void => {
      for (const method of m.def.methods ?? []) {
        let inherited = false;
        for (let a = m.base; a; a = a.base) inherited ||= declares(a, method);
        if (!inherited && declaredBelow(m, method)) {
          let fn = this.fnByName.get(`%${m.def.name}.${method}`);
          if (!fn && m.def.abstractMethods?.includes(method)) {
            // An ABSTRACT declarer has no function; the slot's ABI
            // signature comes from any concrete descendant implementation
            // (the frontend's override exactness makes them identical).
            // No concrete implementation anywhere in the subtree means no
            // instance can dispatch the slot (only abstract classes
            // declare it, and abstract classes never instantiate) — skip.
            const findImpl = (c: ClassMeta): IrFunction | undefined => {
              for (const child of c.children) {
                const f = declares(child, method) && !child.def.abstractMethods?.includes(method)
                  ? this.fnByName.get(`%${child.def.name}.${method}`)
                  : undefined;
                const found = f ?? findImpl(child);
                if (found) return found;
              }
              return undefined;
            };
            fn = findImpl(m);
            if (!fn) continue;
          }
          if (!fn) throw new InternalCompilerError(`emitter bug: missing method function %${m.def.name}.${method}`);
          // Sibling branches can each own a slot for the same method name
          // (each root-most in its own subtree — mixin layers make this
          // routine): the member name disambiguates by occurrence.
          const occurrence = seen.get(method) ?? 0;
          seen.set(method, occurrence + 1);
          root.slots.push({ method, declarer: m, fn, member: mangleVtSlot(method, occurrence) });
        }
      }
      for (const c of m.children) collectSlots(c, root, seen);
    };
    for (const meta of this.classMeta.values()) {
      if (meta.base === null && meta.hierarchy) collectSlots(meta, meta, new Map());
    }
    for (const cls of mod.classes ?? []) {
      for (const m of cls.methods ?? []) {
        if (this.mayThrow.has(`%${cls.name}.${m}`)) this.mayThrowMethods.add(m);
      }
    }
    // Cycle capability, as a greatest fixpoint over shapes and unions:
    // start optimistic (everything cycle-capable), then repeatedly drop
    // shapes with no cycle-capable field and unions with no cycle-capable
    // arm until stable. Closures and promises are always cycle-capable
    // (a captured box can hold anything; a rejection payload is an
    // arbitrary thrown value); strings never are, and arrays/maps inherit
    // their element/value type's capability (a record element can point
    // back at the array holding it). The optimistic start is what keeps
    // self- and mutually-recursive classes traced (`class A { next: A }`).
    const shapeDefs = [
      // The emitter class carries a synthetic closure-typed pseudo-field:
      // its runtime registry OWNS listener closures, so the emitter
      // hierarchy is unconditionally cycle-capable — the fixpoint must
      // never drop it (the pseudo-field never reaches struct emission;
      // runtime classes emit no structs).
      ...(mod.classes ?? []).map((c) => ({
        key: `object:${c.name}`,
        fields: c.name === RUNTIME_EMITTER_CLASS
          ? [...c.fields, { name: "<listeners>", type: funcOf([], VOID) }]
          : c.fields,
      })),
      // An index-signature shape's overflow map participates like a field
      // of map type: the shape is cycle-capable when the overflow VALUE
      // type is (a record/object/union value in the map can point back at
      // the record embedding it) — cycleCapable's map rule answers that.
      ...(mod.records ?? []).map((r) => ({
        key: `record:${r.id}`,
        fields: r.indexValue
          ? [...r.fields, { name: "<overflow>", type: mapOf(STRING, r.indexValue) }]
          : r.fields,
      })),
    ];
    for (const s of shapeDefs) this.tracedShapes.add(s.key);
    // A hierarchy is ONE unit of cycle capability: a base-typed slot can
    // hold any subclass and retain touches the cycle header, so header
    // presence must be uniform across an extends-hierarchy — it is
    // cycle-capable iff ANY member is. Standalone classes and records are
    // singleton units (today's behavior exactly).
    const unitKeyOf = (key: string): string => {
      if (!key.startsWith("object:")) return key;
      const meta = this.classMeta.get(key.slice("object:".length));
      return meta && meta.hierarchy ? `object:${meta.root.def.name}` : key;
    };
    const units = new Map<string, typeof shapeDefs>();
    for (const s of shapeDefs) {
      const unit = unitKeyOf(s.key);
      let members = units.get(unit);
      if (!members) units.set(unit, (members = []));
      members.push(s);
    }
    for (const u of mod.unions ?? []) this.tracedUnions.add(u.id);
    const cycleCapable = (t: IrType): boolean => {
      switch (t.kind) {
        case "func":
        case "promise":
          return true;
        case "object":
          return this.tracedShapes.has(`object:${t.className}`);
        case "record":
          return this.tracedShapes.has(`record:${t.shapeId}`);
        case "union":
          return this.tracedUnions.has(t.unionId);
        // A map is cycle-capable exactly when its VALUE type is: a record/
        // object/union value can hold the map that owns it, while string/
        // array/scalar values cannot point back. Map-valued maps (an
        // index-signature overflow over `Map<K, V>` values) recurse on the
        // inner value. Terminates: IrTypes are finite trees, and the
        // record/union cases read the fixpoint sets.
        case "map":
          return cycleCapable(t.value);
        // An array is cycle-capable exactly when its ELEMENT type is —
        // record/object/union elements (and cycle-capable inner arrays)
        // can point back at the array. Terminates: element types are
        // finite trees, and the record/union cases read the fixpoint sets.
        case "array":
          return cycleCapable(t.elem);
        default:
          return false;
      }
    };
    let shrunk = true;
    while (shrunk) {
      shrunk = false;
      for (const members of units.values()) {
        if (
          this.tracedShapes.has(members[0]!.key) &&
          !members.some((s) => s.fields.some((f) => cycleCapable(f.type)))
        ) {
          for (const s of members) this.tracedShapes.delete(s.key);
          shrunk = true;
        }
      }
      for (const u of mod.unions ?? []) {
        if (this.tracedUnions.has(u.id) && !u.arms.some(cycleCapable)) {
          this.tracedUnions.delete(u.id);
          shrunk = true;
        }
      }
    }
    if (sourceText !== undefined) {
      this.lineStarts = [0];
      for (let i = 0; i < sourceText.length; i++) {
        if (sourceText[i] === "\n") this.lineStarts.push(i + 1);
      }
    }
  }

  emit(): string {
    const body: string[] = [];
    // Function bodies are emitted first (into this.lines) so the literal
    // table is complete; the file is then assembled around them.
    for (const fn of this.mod.functions) {
      this.emitFunction(fn);
      body.push(...this.lines);
      this.lines.length = 0;
    }

    const out: string[] = [
      `/* Generated by scriptc from ${this.mod.sourceFile}. Do not edit. */`,
      `#include "scr_runtime.h"`,
      `#include <math.h>`,
      `#include <stdio.h>`,
      `#include <stdlib.h>`,
      ``,
    ];
    out.push(...this.emitBytesElementHelpers());
    // Struct defs render into their own buffer BEFORE the unit-instance
    // table flushes: class newFns point undefined-armed union fields at
    // interned unit instances (fields start as JS's undefined, not NULL),
    // so the instances they intern must both exist in the map by flush
    // time and be DEFINED earlier in the file than the newFn bodies.
    const structDefs: string[] = [];
    this.emitStructDefs(structDefs);
    for (const [text, sym] of this.literals) {
      const bytes = Buffer.from(text, "utf8");
      out.push(
        `static struct { size_t rc; size_t len; size_t cap; char data[${bytes.length + 1}]; } ${sym} =`,
        `    { SIZE_MAX, ${bytes.length}, ${bytes.length}, ${cStringLiteral(bytes)} };`,
      );
    }
    if (this.literals.size > 0) out.push("");
    for (const [key, sym] of this.unitInstances) {
      // One immortal instance per unit-armed (union, tag): tag set, payload
      // slot and RC entry points zero — retain/release/collector all skip
      // rc == SIZE_MAX, so these never join the RC audit or a trace walk.
      const [unionId, tag] = key.split(":");
      out.push(
        `static ScrUnion ${sym} = { .rc = SIZE_MAX, .tag = ${tag} }; /* ${unionId} unit arm */`,
      );
    }
    if (this.unitInstances.size > 0) out.push("");
    for (const line of structDefs) out.push(line); // program-sized: never spread
    for (const [key, sym] of this.regexInstances) {
      // One immortal ScrRegex per (pattern, flags) literal, pointing at the
      // interned source/flags strings. `.bc` starts NULL: the runtime
      // compiles the pattern lazily on first use and caches it here (and
      // frees it at exit), so unexecuted regexes cost nothing. NOT const —
      // the bc slot mutates.
      const sep = key.indexOf("/");
      const flags = key.slice(0, sep);
      const pattern = key.slice(sep + 1);
      const src = this.internLiteral(pattern);
      const fl = this.internLiteral(flags);
      // "*/" inside the pattern would close the trailing comment.
      const safe = `/${pattern}/${flags}`.split("*/").join("* /");
      out.push(
        `static ${this.mod.lib?.threadInstances === true ? "_Thread_local " : ""}ScrRegex ${sym} = { .rc = SIZE_MAX, .source = (ScrStr *)&${src}, ` +
          `.flags = (ScrStr *)&${fl}, .bc = NULL }; /* ${safe} */`,
      );
    }
    if (this.regexInstances.size > 0) out.push("");
    for (const [, { sym, cooked }] of this.templateStringsInstances) {
      // One immortal ScrArr per tagged-template site: the data slots point
      // at the interned cooked-string literals (address constants — fully
      // static, no lazy init; reads retain immortal strings, a no-op).
      // len == cap and nothing ever mutates it (TemplateStringsArray is
      // ReadonlyArray, tsc rejects the mutating spellings).
      const slots = cooked.map((s) => `(void *)&${this.internLiteral(s)}`).join(", ");
      out.push(
        `static void *${sym}_data[${cooked.length}] = { ${slots} };`,
        `static ScrArr ${sym} = { .rc = SIZE_MAX, .len = ${cooked.length}, .cap = ${cooked.length}, ` +
          `.elem = SCR_ELEM_STR, .elem_retain = NULL, .elem_release = NULL, .elem_trace = NULL, ` +
          `.data = (uint64_t *)${sym}_data };`,
      );
    }
    if (this.templateStringsInstances.size > 0) out.push("");
    const embedded = this.mod.embedded;
    emitNpmEmbedding(this, out);
    const globals = this.mod.globals ?? [];
    // Thread-instanced library state (abi.instance_per_thread): module
    // globals, run-once guards, and the regex literal caches below live in
    // thread-local storage — one full instance per embedder thread,
    // matching the runtime objects compiled with -DSCR_THREAD_INSTANCES.
    // Immutable interned data (string literals, unit arms, template
    // arrays, vtables) stays shared.
    const tl = this.mod.lib?.threadInstances === true ? "_Thread_local " : "";
    for (const g of globals) {
      // File-scope statics: zero/NULL-initialized, assigned by %init
      // functions, released (refcounted ones) before the RC audit runs.
      out.push(`static ${tl}${cDecl(g.type, mangleGlobal(g.id))}; /* ${g.name} */`);
    }
    if (globals.length > 0) out.push("");
    // Outbound native FFI declarations. string/bytes each expand from one
    // scriptc value to a borrowed pointer+length pair. Format-2 callbacks
    // and their independently positioned contexts are exact pointer slots.
    // Library callback channels reuse ffiCall IR but are NOT direct symbol
    // imports: their profile names are registration keys and TypeScript
    // bindings only, and call sites dispatch through the runtime slot. Do
    // not emit extern declarations for them (besides inventing undefined
    // symbols, a valid TS channel name such as `int` is a C keyword).
    const libraryCallbackNames = new Set(this.mod.lib?.callbacks?.map((cb) => cb.name) ?? []);
    const directFfiImports = (this.mod.ffiImports ?? []).filter(
      (entry) => !libraryCallbackNames.has(entry.name),
    );
    for (const entry of directFfiImports) {
      const params = entry.params.flatMap((param): string[] => {
        if (isFfiCallbackParam(param) || isFfiReleaseParam(param)) {
          return [ffiCallbackPointerTypeC(param.callback)];
        }
        if (isFfiContextParam(param)) return ["void *"];
        switch (param) {
          case "f64":
            return ["double"];
          case "bool":
          case "u8":
            return ["uint8_t"];
          case "u32":
            return ["uint32_t"];
          case "i32":
            return ["int32_t"];
          case "string":
          case "bytes":
            return ["const uint8_t *", "size_t"];
        }
      });
      const ret = ffiNativeTypeC(entry.returns);
      out.push(`extern ${ret} ${entry.symbol}(${params.length > 0 ? params.join(", ") : "void"});`);
    }
    if (directFfiImports.length > 0) out.push("");
    for (const fn of this.mod.functions) out.push(this.signature(fn) + ";");
    this.emitFfiCallbackDefs(out);
    // Class objects (classes as values): construct-thunk prototypes plus
    // the immortal statics that take their addresses — after the function
    // signatures (the thunks call sc_new_*/the constructors), before
    // anything that references &sc_co_*.
    emitClassObjs(this, out);
    // Vtable slot adapters: prototyped with the vtables (emitStructDefs),
    // defined here where the method bodies they call are declared.
    this.emitVtAdapterDefs(out);
    // Wrappers + interned closures for declared functions used as values.
    // Placed after the forward declarations (they call sc_f_*) and before
    // the bodies (which reference &sc_fc_*).
    this.emitAsyncScaffolding(out);
    for (const name of this.fnValues) {
      const fn = this.fnByName.get(name)!;
      const params = ["ScrClosure *sc_env", ...fn.params.map((p) => cDecl(p.type, mangleLocal(p.localId)))];
      const call = `${this.callTargetC(name)}(${fn.params.map((p) => mangleLocal(p.localId)).join(", ")})`;
      const retType = fn.async ? "ScrPromise *" : fn.generator ? "ScrGen *" : cType(fn.returnType);
      out.push(
        ``,
        `static ${retType}${retType.endsWith("*") ? "" : " "}${mangleWrapper(name)}(${params.join(", ")}) {`,
        `  (void)sc_env;`,
        fn.returnType.kind === "void" && !fn.async && !fn.generator ? `  ${call};` : `  return ${call};`,
        `}`,
        `static struct { size_t rc; void *fn; size_t ncaps; ScrBox *props; } ${mangleFnClosure(name)} =`,
        `    { SIZE_MAX, (void *)&${mangleWrapper(name)}, 0, NULL };`,
      );
    }
    // Construct-thunk definitions (prototyped with the class objects
    // above): they call sc_new_* and the constructors, both declared.
    emitCtorThunkDefs(this, out);
    // Type-directed JSON walkers (jsonStringify serializers, dynCheck
    // matchers/builders), interned per type during body emission above.
    if (this.walkerProtos.length > 0) {
      out.push("");
      for (const line of this.walkerProtos) out.push(line);
      out.push("");
      for (const line of this.walkerDefs) out.push(line);
    }
    // Loop-appended, never spread: `body` scales with the PROGRAM (a large
    // embedded graph emits hundreds of thousands of lines), and a spread
    // push passes every line as a call argument — the engine's stack
    // overflows long before memory matters.
    out.push("");
    for (const line of body) out.push(line);
    if (this.mod.lib !== undefined) {
      // LIBRARY mode: no main(), no scr_init/scr_lib_init, no event
      // loop — the profile-declared external symbols instead. Everything
      // above is unchanged (still all internal linkage).
      this.emitLibEntries(out, globals);
      return out.join("\n");
    }
    const refGlobals = globals.filter((g) => isRefCounted(g.type));
    // Interned function-value closures are IMMORTAL (rc == SIZE_MAX), so
    // an own-property table Object.defineProperties hung on one would
    // outlive the RC audit — release it with the globals. Only emitted
    // when the dispatch unit is even linked (defineProps is the only
    // writer).
    const fnValueProps = moduleUsesDynInvoke(this.mod) ? [...this.fnValues] : [];
    if (refGlobals.length > 0 || fnValueProps.length > 0) {
      out.push(`static void sc_release_globals(void) {`);
      for (const g of refGlobals) {
        out.push(`  ${releaseCallC(g.type, mangleGlobal(g.id))};`);
      }
      for (const name of fnValueProps) {
        out.push(
          `  if (${mangleFnClosure(name)}.props) { scr_box_release(${mangleFnClosure(name)}.props); ${mangleFnClosure(name)}.props = NULL; }`,
        );
      }
      out.push(`}`, ``);
    }
    const asyncEntry = this.fnByName.get(this.mod.entry)?.async === true;
    const hasAsync = this.mod.functions.some((f) => f.async);
    // Generator programs run the loop too (an empty pass when nothing is
    // pending): its exit accounting notes still-suspended generator
    // fibers as abandoned, so the RC audit downgrades exactly like the
    // async loop-exhaustion story.
    const hasGenerators = this.mod.functions.some((f) => f.generator !== undefined);
    // Embedded npm code can leave island promise chains pending when %main
    // returns (a package function's async work) — the loop's io hook
    // drains the engine's job queue at quiescence, so npm-importing
    // programs always run the loop, like Node always runs its own.
    const usesIsland = embedded !== undefined && embedded.modules.length > 0;
    const snapshotsTlsCa =
      moduleUsesTls(this.mod) ||
      moduleUsesTlsCa(this.mod) ||
      moduleEmbedsBuiltin(this.mod, "node:https") ||
      moduleEmbedsBuiltin(this.mod, "node:tls");
    // A pending module root normally selects Node's exit status 13, but
    // an already-failed node:test run or an embedded process.exitCode has
    // higher precedence. Keep this expression shared with the ordinary
    // successful epilogue so both paths consult the same program verdict.
    const usesNodeTest = moduleUsesNodeTest(this.mod);
    const programExitUsesIsland = !usesNodeTest && usesIsland;
    const programExitCode = usesNodeTest
      ? "scr_test_exit_code()"
      : usesIsland
        ? "scr_island_exit_code()"
        : "0";
    // Exit listeners can read MODULE GLOBALS directly (test/common's
    // runCallChecks over its mustCallChecks ledger — an interned top-level
    // closure, no capture boxes keeping anything alive), so they must run
    // BEFORE sc_release_globals — the atexit half alone would fire after
    // main freed them (observed use-after-free). scr_run_exit_listeners
    // is idempotent (scr_exit_ran), so the atexit becomes a no-op; the
    // code argument is the hint the failure reporters maintain — exactly
    // what the atexit path would have passed. With a retained FFI
    // descriptor the inline call is required even with nothing to
    // release: listeners must beat the atexit FFI ledger sweep (a
    // listener may legitimately release or pump a registration), and
    // only the inline call orders ahead of every atexit handler. Plain
    // event programs with neither keep the atexit path, so their
    // listener timing is unchanged.
    const needsRelease = refGlobals.length > 0 || fnValueProps.length > 0;
    const runExitListeners =
      moduleUsesProcessEvents(this.mod) && (needsRelease || this.ffiHasRetainedCallback)
        ? "scr_run_exit_listeners((double)scr_exit_code_hint_get()); "
        : "";
    const exitCleanup = `${runExitListeners}${needsRelease ? "sc_release_globals(); " : ""}`;
    const releaseGlobals = needsRelease
      ? `  ${runExitListeners}sc_release_globals();`
      : runExitListeners !== ""
        ? `  ${runExitListeners.trim()}`
        : `  /* no refcounted globals */`;
    const uncaught = (indent: string, releaseTop = false) => [
      `${indent}if (scr_exc_pending()) {`,
      `${indent}  scr_exc_print_uncaught();`,
      `${indent}  ${releaseTop ? "scr_promise_release(sc_top); " : ""}` +
        `${exitCleanup}return 1;`,
      `${indent}}`,
    ];
    out.push(
      // Real argc/argv feed the library's interned process.argv (see
      // scr_lib_init — lazy, so argv-free programs allocate nothing).
      `int main(int argc, char **argv) {`,
      `  scr_init();`,
      // The builtin error classes' preorder intervals are program-dependent
      // (they share this module's class-forest numbering, so instanceof and
      // the uncaught printer's Error-range test agree between runtime-made
      // and compiled error objects) — stamp them before any code runs.
      ...this.errorVtStampLines(),
      // The runtime emitter vtable's interval, when the program touches
      // node:events (the class def rides the module exactly then).
      ...emitterVtStampLines(this),
      // The runtime stream vtables' intervals, when the program touches
      // node:stream (the emitter story — instanceof and dynamic teardown
      // both dispatch through them).
      ...streamVtStampLines(this),
      // Node reads NODE_EXTRA_CA_CERTS and the referenced file during
      // process initialization. Native fetch performs the same idempotent
      // install from scr_fetch_install.
      ...(snapshotsTlsCa ? [`  scr_tls_ca_install();`] : []),
      `  scr_lib_init(argc, argv);`,
      // Fetch-referencing programs register the native fetch bridge before any
      // island entry (the engine's lazy boot consults it): the ONLY
      // reference to scr_fetch.c, so fetch-free builds never compile or
      // link it (native-toolchain.ts gates on the same predicate). moduleUsesFetch is
      // true only for fetch-referencing embedded graphs and for USER-code
      // fetch (the island-backed ambient's globalGet) — both boot the
      // engine before the global is read.
      ...(moduleUsesFetch(this.mod) ? [`  scr_fetch_install();`] : []),
      // Embedded graphs that import node:zlib register the island's zlib
      // bridge before any island entry — the ONLY reference to
      // scr_zlib_island.c (native-toolchain.ts compiles it on the same predicate), so
      // zlib-free dynamic builds keep the island's clear refusal.
      ...(moduleEmbedsBuiltin(this.mod, "node:zlib") ? [`  scr_zlib_island_install();`] : []),
      // Embedded graphs that import node:http/https register the island's
      // http client bridge (scr_net_island.c — native-toolchain.ts compiles it and the
      // socket units on the same predicate; native-fetch builds also
      // register it from scr_fetch_install, idempotently).
      ...(moduleEmbedsBuiltin(this.mod, "node:http") || moduleEmbedsBuiltin(this.mod, "node:https")
        ? [`  scr_net_island_install();`]
        : []),
      // Event-surface programs (signal/exit listeners, stdin events) fill
      // the loop's nullable event hooks before %main — the events unit
      // (scr_events.c) links only when this line is emitted (native-toolchain.ts gates
      // on the same predicate, like fetch).
      ...(moduleUsesProcessEvents(this.mod) ? [`  scr_events_install();`] : []),
      // Net-surface programs fill the loop's net hooks before %main — the
      // net unit (scr_net.c) links only when this line is emitted (native-toolchain.ts
      // gates on the same predicate, like events). The dyn-install twin
      // stamps the netSocket handle-dispatch ops into the dyn core so
      // sockets can cross the checked-dynamic boundary (SCR_DYN_HANDLE).
      ...(moduleUsesNet(this.mod) ? [`  scr_net_install();`, `  scr_net_dyn_install();`] : []),
      // Http-surface programs additionally stamp the httpReq/httpRes
      // handle-dispatch ops (scr_http.c links exactly when this line is
      // emitted — native-toolchain.ts's http gate).
      ...(moduleUsesHttpServer(this.mod) ? [`  scr_http_dyn_install();`] : []),
      // http2-surface programs stamp the h2 session/stream handle-dispatch
      // ops (scr_http2.c links exactly when this line is emitted — native-toolchain.ts's
      // http2 gate).
      ...(moduleUsesHttp2(this.mod) ? [`  scr_http2_dyn_install();`] : []),
      // Stream-surface programs fill the loop's stream hook (the deferred
      // next-tick emissions) before %main — scr_stream.c links only when
      // this line is emitted (native-toolchain.ts gates on the same predicate).
      ...(moduleUsesStream(this.mod) ? [`  scr_stream_install();`] : []),
      // Dgram/dns-surface programs fill the loop's dgram hooks the same
      // way — scr_dgram.c links only when this line is emitted.
      ...(moduleUsesDgram(this.mod) ? [`  scr_dgram_install();`] : []),
      // fs.watch programs fill the loop's watch hooks the same way —
      // scr_watch.c links only when this line is emitted.
      ...(moduleUsesFsWatch(this.mod) ? [`  scr_watch_install();`] : []),
      ...(this.ffiHasForeignCallback ? [`  scr_ffi_install();`] : []),
      // The embedded npm tables must be registered before %main: the %init
      // functions it calls import from them. Static data only — the engine
      // still boots lazily, on the first island entry. Compressed module
      // text (island.ts stores big sources as raw DEFLATE) needs the
      // inflater installed first — scr_zlib.c joins the link on the same
      // moduleEmbedsCompressedNpm predicate (index.ts's zlib switch), so
      // compression-free dynamic builds keep their exact link line.
      ...(embedded && embedded.modules.length > 0
        ? [
            ...(moduleEmbedsCompressedNpm(this.mod)
              ? [`  scr_island_set_inflate(scr_zlib_inflate_exact);`]
              : []),
            `  scr_island_modules(sc_npm_modules, ${embedded.modules.length}, ` +
              `${embedded.edges.length > 0 ? "sc_npm_edges" : "NULL"}, ${embedded.edges.length});`,
          ]
        : []),
      ...(asyncEntry
        ? [`  ScrPromise *sc_top = ${mangleAsyncSpawn(this.mod.entry)}();`]
        : [`  ${mangleFunction(this.mod.entry)}();`]),
      // Uncaught exception from top-level code: Node exits 1.
      ...(this.mayThrow.has(this.mod.entry) && !asyncEntry ? uncaught("  ") : []),
      // The event loop runs to exhaustion (microtasks before timers). A
      // throw escaping a timer callback and unhandled promise rejections
      // both exit 1, like Node.
      ...(hasAsync || hasGenerators || this.usesTimers || usesIsland || this.ffiHasForeignCallback
        ? [
            `  bool sc_loop_rejection = scr_loop_run(${asyncEntry ? "sc_top" : "NULL"});`,
            ...uncaught("  ", asyncEntry),
            `  if (sc_loop_rejection) {`,
            `    scr_discard_unhandled_rejections();`,
            ...(asyncEntry ? [`    scr_promise_release(sc_top);`] : []),
            `    ${exitCleanup}return 1;`,
            `  }`,
            ...(asyncEntry
              ? [
                  `  int sc_top_status = scr_promise_finish_top_level(sc_top);`,
                  `  if (sc_top_status == 1) {`,
                  // Earlier-checkpoint rejections were decided inside the
                  // loop. The fatal module verdict suppresses unrelated
                  // rejections from THIS checkpoint, exactly Node's order.
                  `    scr_discard_unhandled_rejections();`,
                  `    scr_promise_rethrow_top_level(sc_top);`,
                  `    scr_promise_release(sc_top);`,
                  `    scr_exc_print_uncaught();`,
                  `    ${exitCleanup}return 1;`,
                  `  }`,
                  `  scr_promise_release(sc_top);`,
                ]
              : []),
            `  if (scr_report_unhandled_rejections()) {`,
            `    ${exitCleanup}return 1;`,
            `  }`,
            ...(asyncEntry
              ? [
                  `  if (sc_top_status == 13) {`,
                  `    int sc_exit_status = ${programExitCode};`,
                  `    if (sc_exit_status == 0) sc_exit_status = sc_top_status;`,
                  ...(programExitUsesIsland && runExitListeners !== ""
                    ? [`    size_t sc_exit_code_version = scr_island_exit_code_version();`]
                    : []),
                  // finish_top_level initially notes 13; replace that hint
                  // before exit listeners run when a higher-priority
                  // verdict has already selected the process status.
                  `    scr_exit_code_note(sc_exit_status);`,
                  ...(runExitListeners !== "" ? [`    ${runExitListeners.trim()}`] : []),
                  ...(programExitUsesIsland && runExitListeners !== ""
                    ? [
                        `    if (scr_island_exit_code_version() != sc_exit_code_version) {`,
                        `      sc_exit_status = scr_island_exit_code();`,
                        `      scr_exit_code_note(sc_exit_status);`,
                        `    }`,
                      ]
                    : []),
                  ...(needsRelease ? [`    sc_release_globals();`] : []),
                  `    return sc_exit_status;`,
                  `  }`,
                ]
              : []),
          ]
        : []),
      releaseGlobals,
      // node:test programs exit through the runner's verdict (Node's
      // contract: 1 when any non-todo test failed). The loop-run above is
      // guaranteed for these programs — every registration libCall sets
      // usesTimers, so the runner fiber always drains before this line.
      // Island programs exit with process.exitCode when the embedded
      // graph set it (Node's implicit exit status: set it, return
      // normally, exit with it) — 0 when never set.
      `  return ${programExitCode};`,
      `}`,
      ``,
    );
    return out.join("\n");
  }

  /* ── library mode ─────────────────────────────────────────────────────
   * The program TU's ONLY external-linkage definitions: the export-map
   * wrappers plus the mode-provided init / sink-registration / reset /
   * collect entries, all delegating their runtime halves to scr_library.c so
   * both backends' emitted bodies are trivially identical. The init entry
   * IS module-graph evaluation: full deterministic reset (program globals
   * released and zeroed — run-once guards included — then the runtime's
   * session reset), the error-vt interval stamps verbatim from today's
   * main, then %main, then the escaped-exception check. */
  emitLibEntries(out: string[], globals: IrGlobal[]): void {
    const lib = this.mod.lib!;
    const autoReset = lib.resultResetSymbol === null;
    out.push(``, `/* ── library-mode entries (profile: ${lib.profileName}) ── */`, ``);
    // Session reset of PROGRAM state: release every refcounted global and
    // zero everything (the run-once module guards included), putting the
    // program back at the not-yet-evaluated state.
    out.push(`static void sc_lib_release_globals(void) {`);
    for (const g of globals) {
      const name = mangleGlobal(g.id);
      if (isRefCounted(g.type)) {
        out.push(`  ${releaseCallC(g.type, name)}; ${name} = NULL; /* ${g.name} */`);
      } else if (g.type.kind === "bool") {
        out.push(`  ${name} = false; /* ${g.name} */`);
      } else {
        out.push(`  ${name} = 0; /* ${g.name} */`);
      }
    }
    if (globals.length === 0) out.push(`  /* no globals */`);
    out.push(`}`, ``);

    // The runtime detected-trap overlay table (scr_runtime.h declares it,
    // the library trap funnel consults it): flat code/teaching/remediation
    // triples, one per runtime trap code (SC4013–SC4019) the profile
    // declares text for. NULL keeps the funnel's default for that cell;
    // the empty table still defines the symbols the funnel links against.
    if (lib.trapOverlays.length === 0) {
      out.push(`const char *const scr_library_trap_overlays[] = { NULL };`);
    } else {
      const cells = lib.trapOverlays.flatMap((o) => [
        cStringLiteral(Buffer.from(o.code, "utf8")),
        o.teaching !== undefined ? cStringLiteral(Buffer.from(o.teaching, "utf8")) : "NULL",
        o.remediation !== undefined ? cStringLiteral(Buffer.from(o.remediation, "utf8")) : "NULL",
      ]);
      out.push(`const char *const scr_library_trap_overlays[] = { ${cells.join(", ")} };`);
    }
    out.push(`const size_t scr_library_trap_overlays_len = ${lib.trapOverlays.length};`, ``);

    out.push(
      `void ${lib.initSymbol}(void) {`,
      `  scr_library_entry(true, "${lib.initSymbol}"); /* init always resets the result arena */`,
      `  sc_lib_release_globals();`,
      `  scr_library_reset();`,
      ...this.errorVtStampLines(),
      ...emitterVtStampLines(this),
      `  ${mangleFunction(this.mod.entry)}();`,
      `  scr_library_check_exc();`,
      `}`,
      ``,
      `void ${lib.sinkRegisterSymbol}(void (*fn)(void *ctx, const uint8_t *msg, size_t msg_len, uint64_t address), void *ctx) {`,
      `  scr_library_callback_entry_guard("${lib.sinkRegisterSymbol}");`,
      `  scr_library_set_sink(fn, ctx);`,
      `}`,
      ``,
    );
    if (lib.callbacks !== undefined && lib.callbacks.length > 0) {
      // Host-callback registration: a pure store dispatch (the sink
      // registration's rule — no entry prologue, no poison guard, legal
      // before init) except the first operation rejects callback-time
      // re-entry (SC4026). The channel name selects the slot; an unknown or
      // NULL name is a defined -1, never a store. Latest registration
      // wins; a NULL fn clears the channel.
      out.push(
        `int32_t ${lib.callbackRegisterSymbol}(const char *name, void (*fn)(void), void *ctx) {`,
        `  scr_library_callback_entry_guard("${lib.callbackRegisterSymbol}");`,
        `  if (name == NULL) return -1;`,
      );
      for (const cb of lib.callbacks) {
        out.push(
          `  if (strcmp(name, ${cStringLiteral(Buffer.from(cb.name, "utf8"))}) == 0) {`,
          `    scr_library_cb_set(${cb.slot}, fn, ctx); /* channel '${cb.name}' */`,
          `    return 0;`,
          `  }`,
        );
      }
      out.push(`  return -1;`, `}`, ``);
    }
    if (lib.identity !== undefined && this.options.emitLibraryIdentity !== false) {
      // Profile-declared identity getters (the ask-2 sidecar's boot-time
      // pairing fence): pure data returns with NO entry prologue — exempt
      // from the poisoned guard and every runtime touch (ratified), so a
      // host can read them before init and after a trap.
      out.push(...emitLibraryIdentityLines("c", lib.identity));
    }
    if (lib.resultResetSymbol !== null) {
      out.push(
        `void ${lib.resultResetSymbol}(void) {`,
        `  scr_library_entry(false, "${lib.resultResetSymbol}");`,
        `  scr_library_arena_reset();`,
        `}`,
        ``,
      );
    }
    if (lib.collectSymbol !== null) {
      out.push(
        `void ${lib.collectSymbol}(void) {`,
        `  scr_library_entry(false, "${lib.collectSymbol}");`,
        `  scr_library_collect(); /* arena reset + a full cycle collection */`,
        `}`,
        ``,
      );
    }
    for (const e of lib.exports) {
      const params: string[] = [];
      const args: string[] = [];
      e.params.forEach((cls, i) => {
        switch (cls) {
          case "f64":
            params.push(`double a${i}`);
            args.push(`a${i}`);
            break;
          case "bool":
            params.push(`uint8_t a${i}`);
            args.push(`(a${i} != 0)`);
            break;
          case "u8":
            params.push(`uint8_t a${i}`);
            args.push(`(double)a${i}`);
            break;
          case "u32":
            params.push(`uint32_t a${i}`);
            args.push(`(double)a${i}`);
            break;
          case "i32":
            params.push(`int32_t a${i}`);
            args.push(`(double)a${i}`);
            break;
          case "i64":
            // The inbound declared-integer edge (ask 4): the helper
            // converts exactly or delivers the host-contract trap — a
            // value past ±(2^53−1) cannot ride f64 without silent
            // rounding, which is a coercion the author never wrote.
            params.push(`int64_t a${i}`);
            args.push(`scr_library_i64_in(a${i}, ${cStringLiteral(Buffer.from(e.inboundIntTrap!, "utf8"))})`);
            break;
          case "u64":
            params.push(`uint64_t a${i}`);
            args.push(`scr_library_u64_in(a${i}, ${cStringLiteral(Buffer.from(e.inboundIntTrap!, "utf8"))})`);
            break;
          case "string":
            params.push(`const uint8_t *a${i}_ptr`, `size_t a${i}_len`);
            args.push(`scr_library_str_in(a${i}_ptr, a${i}_len)`);
            break;
          case "bytes":
            params.push(`const uint8_t *a${i}_ptr`, `size_t a${i}_len`);
            // The helper's trap message is the compiler-assembled
            // structured trap-teaching form (0x01 text 0x1F SC4012 0x1F
            // symbol [0x1F remediation]) — assembled once at export
            // resolution, identical across both backends.
            args.push(`scr_library_bytes_in(a${i}_ptr, a${i}_len, ${cStringLiteral(Buffer.from(e.inboundBytesTrap!, "utf8"))})`);
            break;
        }
      });
      if (e.returns === "string" || e.returns === "bytes") {
        params.push(`const uint8_t **out`, `size_t *out_len`);
      }
      const retType =
        e.returns === "f64" ? "double"
        : e.returns === "bool" ? "uint8_t"
        : e.returns === "i64" ? "int64_t"
        : e.returns === "u64" ? "uint64_t"
        : "void";
      const call = `${mangleFunction(e.fnName)}(${args.join(", ")})`;
      out.push(`${retType} ${e.symbol}(${params.length > 0 ? params.join(", ") : "void"}) {`);
      // The prologue records this entry's symbol in the funnel's
      // current-entry slot: a detected trap anywhere below names the
      // entry the host called (structured trap-teaching field 2).
      out.push(`  scr_library_entry(${autoReset ? "true" : "false"}, "${e.symbol}");`);
      switch (e.returns) {
        case "void":
          out.push(`  ${call};`, `  scr_library_check_exc();`);
          break;
        case "f64":
          out.push(`  double sc_r = ${call};`, `  scr_library_check_exc();`, `  return sc_r;`);
          break;
        case "i64":
        case "u64":
          // The outbound declared-integer edge (ask 4): every value
          // reaching this return was PROVEN whole and inside the class's
          // range at compile time, so the cast is exact by construction
          // (and the unwind path's 0.0 converts cleanly).
          out.push(
            `  double sc_r = ${call};`,
            `  scr_library_check_exc();`,
            `  return (${retType})sc_r;`,
          );
          break;
        case "bool":
          out.push(`  bool sc_r = ${call};`, `  scr_library_check_exc();`, `  return (uint8_t)(sc_r ? 1 : 0);`);
          break;
        case "string":
          out.push(`  ScrStr *sc_r = ${call};`, `  scr_library_check_exc();`, `  scr_library_str_out(sc_r, out, out_len);`);
          break;
        case "bytes":
          out.push(`  ScrBytes *sc_r = ${call};`, `  scr_library_check_exc();`, `  scr_library_bytes_out(sc_r, out, out_len);`);
          break;
      }
      out.push(`}`, ``);
    }
  }

  emitAsyncScaffolding(out: string[]): void {
    return emitAsyncScaffolding(this, out);
  }

  emitStructDefs(out: string[]): void {
    return emitStructDefs(this, out);
  }

  /* ── vtables (class hierarchies) ──────────────────────────────────────
   * One vtable struct type per hierarchy (named after the root): a ScrVt
   * head — the class's preorder interval for instanceof and its DIRECT
   * release for dynamic teardown — plus one member per virtual slot. Only
   * methods actually overridden somewhere have slots; the slot's signature
   * is the root-most declaring class's, and overriding implementations sit
   * behind reinterpreting adapters (prefix layout makes the `this` cast
   * sound). Each class gets one static const vtable instance stamped into
   * every object it allocates. */

  vtEntriesFor(meta: ClassMeta): { slot: VtSlot; impl: ClassMeta | null }[] {
    return vtEntriesFor(this, meta);
  }

  vtSlotParams(slot: VtSlot, named: boolean): string[] {
    return vtSlotParams(this, slot, named);
  }

  emitVtableDecls(out: string[], hierarchyClasses: ClassMeta[]): void {
    return emitVtableDecls(this, out, hierarchyClasses);
  }

  emitVtableInstances(out: string[], hierarchyClasses: ClassMeta[]): void {
    return emitVtableInstances(this, out, hierarchyClasses);
  }

  emitVtAdapterDefs(out: string[]): void {
    return emitVtAdapterDefs(this, out);
  }

  emitHierarchyClassHelpers(out: string[],
    meta: ClassMeta,
    s: {
      struct: string;
      newFn: string;
      retain: string;
      release: string;
      trace: string;
      gcFree: string;
      traced: boolean;
      fields: { name: string; type: IrType }[];
    },): void {
    return emitHierarchyClassHelpers(this, out, meta, s);
  }

  /* ── type-directed JSON walkers (jsonStringify / dynCheck) ────────────
   * No dyn is built for stringify and no tags are consulted: the STATIC IR
   * type drives everything, one emitted helper per typeKey (interned, like
   * the array-HOF desugars). dynCheck helpers walk the runtime dyn (ScrDyn)
   * against the target type: match predicates (sc_dm_*) answer "does this
   * dyn fit?" without throwing (union arms are tried in canonical order —
   * first FULL match wins), and builders (sc_dc_*) construct the typed
   * value (+1) or throw a path-annotated TypeError through the exception
   * cell. Recursion terminates because recursive shapes/unions are rejected
   * by the frontend. */

  islandAdapter(arity: number, retKind: "void" | "jsval" | "f64" | "bool" | "string"): string {
    return islandAdapter(this, arity, retKind);
  }

  islandTypedAdapter(fn: IrType & { kind: "func" }): string {
    return islandTypedAdapter(this, fn);
  }

  unionTruthyHelper(unionId: string): string {
    return unionTruthyHelper(this, unionId);
  }

  unionEqHelper(unionId: string, sameValue: boolean): string {
    return unionEqHelper(this, unionId, sameValue);
  }

  unionToStrHelper(unionId: string): string {
    return unionToStrHelper(this, unionId);
  }

  unionJoinHelper(unionId: string): string {
    return unionJoinHelper(this, unionId);
  }

  jsonWriteHelper(t: IrType): string {
    return jsonWriteHelper(this, t);
  }

  jsonIndentHelper(): string {
    return jsonIndentHelper(this);
  }

  dynMatchHelper(t: IrType): string {
    return dynMatchHelper(this, t);
  }

  dynCheckHelper(t: IrType): string {
    return dynCheckHelper(this, t);
  }

  toDynHelper(t: IrType): string {
    return toDynHelper(this, t);
  }

  dynFuncBoxHelper(t: IrType & { kind: "func" }): string {
    return dynFuncBoxHelper(this, t);
  }

  recordKeyGetHelper(shapeId: string, t: IrType, overflowOnly = false): string {
    return recordKeyGetHelper(this, shapeId, t, overflowOnly);
  }

  recordKeySetHelper(shapeId: string): string {
    return recordKeySetHelper(this, shapeId);
  }

  dynToStrHelper(): string {
    return dynToStrHelper(this);
  }

  caughtToDynHelper(): string {
    return caughtToDynHelper(this);
  }

  /* ── cycle-collection wiring ──────────────────────────────────────────
   * Containers that store a payload's RC entry points as function pointers
   * (obj-kind boxes, union ref arms, promise payloads, the exception cell)
   * also store the payload type's TRACE entry point — non-NULL exactly when
   * the payload type carries a cycle header, which is what the container's
   * own trace keys on (visit when present, release at teardown when not).
   * Closures/unions/promises always carry one (runtime-provided traces);
   * classes/records carry one iff their shape can participate in a cycle
   * (emitted trace); strings/arrays/dyn never can. */

  traceAdapterC(t: IrType): string | null {
    return traceAdapterC(this, t);
  }

  traceArgC(t: IrType): string {
    return traceArgC(this, t);
  }

  boxNewC(t: IrType): string {
    return boxNewC(this, t);
  }

  arrNewC(elem: IrType, capExpr: string | number): string {
    return arrNewC(this, elem, capExpr);
  }

  /* ── plumbing ─────────────────────────────────────────────────────── */

  integerLoopIndex(expr: IrExpr): string | null {
    return expr.kind === "varRef" ? this.integerLoopBindings.get(expr.localId) ?? null : null;
  }

  bytesElementHelper(op: "get" | "set", elem: IrBytesElem, integerIndex = false): string {
    const mode = integerIndex ? "u64" : "f64";
    this.bytesElementHelpers.add(`${op}:${elem}:${mode}`);
    return `sc_bytes_${op}_${elem}${integerIndex ? "_u64" : ""}`;
  }

  private emitBytesElementHelpers(): string[] {
    if (this.bytesElementHelpers.size === 0) return [];
    const hasF64 = [...this.bytesElementHelpers].some((key) => key.endsWith(":f64"));
    const hasU64 = [...this.bytesElementHelpers].some((key) => key.endsWith(":u64"));
    const out = [`/* Typed-array hot paths specialized from the IR element kind. */`];
    if (hasF64) {
      out.push(
        `static inline size_t sc_bytes_index_checked(const ScrBytes *b, double i) {`,
        `  if (!(i >= 0.0 && i < (double)b->len)) { (void)scr_bytes_get(b, i); return 0; }`,
        `  size_t idx = (size_t)i;`,
        `  if ((double)idx != i) { (void)scr_bytes_get(b, i); return 0; }`,
        `  return idx;`,
        `}`,
      );
    }
    if (hasU64) {
      out.push(
        `static inline size_t sc_bytes_index_u64_checked(const ScrBytes *b, uint64_t i) {`,
        `  if (i >= b->len) { (void)scr_bytes_get(b, (double)i); return 0; }`,
        `  return (size_t)i;`,
        `}`,
      );
    }
    if ([...this.bytesElementHelpers].some((key) => key.startsWith("set:") && key.split(":")[1] !== "f32")) {
      out.push(
        `static inline uint32_t sc_bytes_coerce_u32(double v) {`,
        `  if (v >= -9007199254740992.0 && v <= 9007199254740992.0) return (uint32_t)(int64_t)v;`,
        `  if (v != v || isinf(v)) return 0;`,
        `  double t = fmod(trunc(v), 4294967296.0);`,
        `  if (t < 0) t += 4294967296.0;`,
        `  return (uint32_t)t;`,
        `}`,
      );
    }
    for (const elem of ["u8", "u32", "i32", "f32"] as const) {
      for (const mode of ["f64", "u64"] as const) {
        const suffix = mode === "u64" ? "_u64" : "";
        const indexType = mode === "u64" ? "uint64_t" : "double";
        const checked = mode === "u64" ? "sc_bytes_index_u64_checked" : "sc_bytes_index_checked";
        if (this.bytesElementHelpers.has(`get:${elem}:${mode}`)) {
          if (elem === "u8") {
            out.push(
              `static inline double sc_bytes_get_u8${suffix}(const ScrBytes *b, ${indexType} i) {`,
              `  return (double)b->data[${checked}(b, i)];`,
              `}`,
            );
          } else {
            const valueType = elem === "f32" ? "float" : elem === "i32" ? "int32_t" : "uint32_t";
            out.push(
              `static inline double sc_bytes_get_${elem}${suffix}(const ScrBytes *b, ${indexType} i) {`,
              `  ${valueType} v;`,
              `  memcpy(&v, b->data + ${checked}(b, i) * 4, 4);`,
              `  return (double)v;`,
              `}`,
            );
          }
        }
        if (this.bytesElementHelpers.has(`set:${elem}:${mode}`)) {
          if (elem === "u8") {
            out.push(
              `static inline void sc_bytes_set_u8${suffix}(ScrBytes *b, ${indexType} i, double v) {`,
              `  b->data[${checked}(b, i)] = (uint8_t)sc_bytes_coerce_u32(v);`,
              `}`,
            );
          } else {
            const valueType = elem === "f32" ? "float" : "uint32_t";
            const init = elem === "f32" ? `(float)v` : `sc_bytes_coerce_u32(v)`;
            out.push(
              `static inline void sc_bytes_set_${elem}${suffix}(ScrBytes *b, ${indexType} i, double v) {`,
              `  size_t idx = ${checked}(b, i);`,
              `  ${valueType} stored = ${init};`,
              `  memcpy(b->data + idx * 4, &stored, 4);`,
              `}`,
            );
          }
        }
      }
    }
    out.push("");
    return out;
  }

  line(text: string): void {
    this.lines.push("  ".repeat(this.indent) + text);
  }

  srcComment(loc: SrcLoc): string {
    if (!this.lineStarts) return "";
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= loc.start) lo = mid;
      else hi = mid - 1;
    }
    return ` /* ${this.mod.sourceFile}:${lo + 1} */`;
  }

  newTemp(type: IrType, init: string): Temp {
    const name = `sc_t${this.tempCounter++}`;
    this.line(`${cDecl(type, name)} = ${init};`);
    if (isRefCounted(type)) this.currentFrame().push({ name, type });
    return { name, type };
  }

  /** A borrowed compiler temp. Used only when a surrounding operation has
   * proved that evaluation cannot overwrite the owning binding before the
   * temp's last use. Unlike newTemp, this does not join the release frame. */
  newBorrowedTemp(type: IrType, init: string): Temp {
    const name = `sc_t${this.tempCounter++}`;
    this.line(`${cDecl(type, name)} = ${init};`);
    return { name, type };
  }

  /** newTemp for a MAY-THROW runtime call: the result joins its frame
   * BEFORE the standard pending check, so an unwind releases the dummy
   * (NULL for refcounted kinds) harmlessly and the value is only read past
   * the check. The shared shape of every fallible boundary call — jsOp,
   * jsExit, composite jsMarshal, dynCheck, await reads. */
  fallibleTemp(type: IrType, call: string): Temp {
    const t = this.newTemp(type, call);
    this.emitPendingCheck();
    return t;
  }

  currentFrame(): Temp[] {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new InternalCompilerError("emitter bug: no active statement frame");
    return frame;
  }

  /** Strike a refcounted temp from its frame: ownership is being moved. */
  moveTemp(t: Temp): void {
    if (!isRefCounted(t.type)) return;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const idx = this.frames[i]!.findIndex((e) => e.name === t.name);
      if (idx >= 0) {
        this.frames[i]!.splice(idx, 1);
        return;
      }
    }
    throw new InternalCompilerError(`emitter bug: moved temp ${t.name} not found in any frame`);
  }

  /** The release call for one owned refcounted value. */
  releaseValue(name: string, type: IrType): void {
    this.line(`${releaseCallC(type, name)};`);
  }

  releaseFrame(frame: ScopeEntry[]): void {
    for (const t of frame) {
      if (t.boxed) this.line(`scr_box_release(${t.name});`);
      else this.releaseValue(t.name, t.type);
    }
  }

  /** THE release-on-jump path (break/continue/return): pending statement
   * frames and entered scopes down to (and excluding nothing above) the
   * given depths, innermost first — everything whose normal fall-through
   * releases the jump bypasses. The jump target's own frame/scope stay
   * live: a loop's releases after the loop and a switch's after its end
   * label are still on the jump's path (return passes 0/0 — it leaves the
   * whole function). */
  releaseForJump(frameDepth: number, scopeDepth: number): void {
    for (let i = this.frames.length - 1; i >= frameDepth; i--) this.releaseFrame(this.frames[i]!);
    for (let i = this.scopes.length - 1; i >= scopeDepth; i--) this.releaseFrame(this.scopes[i]!);
  }

  /** THE unwind path at a point where an exception is pending: release
   * everything between here and the innermost try handler — or the whole
   * function — via releaseForJump, then jump to the handler / return a
   * dummy value (never read: callers of a may-throw function test the
   * pending flag before using the result). Callers own the surrounding
   * `if (scr_exc_pending())`; a `throw` unwinds unconditionally. */
  emitUnwind(): void {
    const target = this.tryStack[this.tryStack.length - 1];
    if (target) {
      this.releaseForJump(target.frameDepth, target.scopeDepth);
      target.used = true;
      this.line(`goto ${target.label};`);
      return;
    }
    this.releaseForJump(0, 0);
    const t = this.currentReturnType;
    if (t.kind === "void") this.line(`return;`);
    else if (t.kind === "f64" || t.kind === "date") this.line(`return 0;`);
    else if (t.kind === "bool") this.line(`return false;`);
    else this.line(`return NULL;`);
  }

  errorVtStampLines(): string[] {
    return errorVtStampLines(this);
  }

  /** The C symbol a direct call or closure enters a function through:
   * async bodies are entered via their emitted spawn wrapper (which runs
   * the fiber eagerly to its first suspension and returns the promise);
   * generator bodies via theirs (which only ALLOCATES the suspended
   * fiber and returns the generator object). */
  callTargetC(fnName: string): string {
    const fn = this.fnByName.get(fnName);
    if (fn?.async === true) return mangleAsyncSpawn(fnName);
    if (fn?.generator !== undefined) return mangleGenSpawn(fnName);
    return mangleFunction(fnName);
  }

  /** The emitter contract for exceptions: after EVERY call that can throw
   * (per the may-throw analysis), test the pending flag and unwind. */
  emitPendingCheck(): void {
    this.line(`if (scr_exc_pending()) {`);
    this.indent++;
    this.emitUnwind();
    this.indent--;
    this.line(`}`);
  }

  internLiteral(text: string): string {
    let sym = this.literals.get(text);
    if (!sym) {
      sym = `sc_lit_${this.literals.size}`;
      this.literals.set(text, sym);
    }
    return sym;
  }

  /** The class object's static symbol (classes as values), registering it
   * for assembly on first use and interning the .name literal while the
   * literal table is still open (bodies emit before the file assembles —
   * the regex-literal discipline). */
  classObjSym(className: string): string {
    let sym = this.classObjs.get(className);
    if (!sym) {
      const meta = this.classMeta.get(className);
      if (!meta) throw new InternalCompilerError(`emitter bug: classRef to unknown class ${className}`);
      this.internLiteral(meta.def.jsName ?? "");
      sym = mangleClassObj(className);
      this.classObjs.set(className, sym);
    }
    return sym;
  }

  /** The interned immortal instance for a UNIT arm of a union — asserts the
   * arm really is payload-less (undefined/null). */
  internUnitInstance(unionId: string, tag: number): string {
    const arm = this.unionsById.get(unionId)?.arms[tag];
    if (!arm || !isUnitType(arm)) {
      throw new InternalCompilerError(`emitter bug: unit instance for non-unit arm ${tag} of ${unionId}`);
    }
    const key = `${unionId}:${tag}`;
    let sym = this.unitInstances.get(key);
    if (!sym) {
      sym = `sc_unit_${this.unitInstances.size}`;
      this.unitInstances.set(key, sym);
    }
    return sym;
  }

  /** The C expression for that instance — the one pointer every unit-arm
   * value of this (union, tag) is: rc == SIZE_MAX, so RC entry points and
   * the collector both skip it and no retain is ever owed. */
  unitInstanceRef(unionId: string, tag: number): string {
    return `(ScrUnion *)&${this.internUnitInstance(unionId, tag)}`;
  }

  /** The class-newFn initialization line for a field whose type ADMITS
   * undefined — such fields start as JS's `undefined`, never the calloc
   * NULL: tsc's strictPropertyInitialization accepts them with no
   * initializer and no constructor assignment (undefined is in the type),
   * so a fresh instance is readable before any assignment runs — a method
   * assigns later, a constructor branch skips it, a base constructor's
   * virtual call reads a derived field before super() returns. Node reads
   * `undefined` there; a NULL payload pointer would be a segfault (union
   * fields) or a silent nothing (jsval fields). Undefined-armed unions get
   * the interned immortal unit instance (free; releases skip it); jsval
   * (`any`) fields get an engine undefined cell — such classes exist only
   * in --dynamic builds, and the field's release balances it. Empty for
   * every type that cannot hold undefined (tsc's SPI guards those) and for
   * record shapes' construction paths, which write every field. */
  undefFieldInitLineC(name: string, t: IrType): string[] {
    if (t.kind === "jsval") {
      return [`  o->${mangleField(name)} = scr_jsval_undefined(); /* ${name} starts undefined */`];
    }
    const tag = undefinedArmTag(t, this.unionsById);
    if (tag < 0 || t.kind !== "union") return [];
    return [`  o->${mangleField(name)} = ${this.unitInstanceRef(t.unionId, tag)}; /* ${name} starts undefined */`];
  }

  /* ── functions ────────────────────────────────────────────────────── */

  ffiCallbackAdapter(binding: string, id: string): FfiCallbackAdapter {
    const adapter = this.ffiCallbackAdapters.get(`${binding}:${id}`);
    if (!adapter) throw new InternalCompilerError(`emitter bug: no callback adapter for ${binding}:${id}`);
    return adapter;
  }

  /** C-callable trampolines for format-2/3/4 callbacks. The external callback
   * ABI is scalar C, format-3 copy-in string/byte slots, plus an optional
   * exact-position context pointer; the internal side is scriptc's
   * (ScrClosure *env, params...) convention. A raw callback borrows its
   * closure through a distinct TLS slot for the dynamic extent of the outer
   * call, or a process-global slot for retained replace semantics. */
  emitFfiCallbackDefs(out: string[]): void {
    if (this.ffiCallbackAdapters.size === 0) return;
    for (const adapter of this.ffiCallbackAdapters.values()) {
      const cb = adapter.callback;
      if (adapter.tls !== null) {
        out.push(`static _Thread_local ScrClosure *${adapter.tls};`);
      }
      if (adapter.global !== null) {
        out.push(`static ScrClosure *${adapter.global};`);
      }
      if (adapter.table !== null) {
        out.push(`static ScrFfiTable ${adapter.table};`);
      }
      const nativeParams = ffiCallbackNativeParamsC(cb, true);
      const ret = ffiNativeTypeC(cb.returns);
      const contextParam = cb.params.findIndex(isFfiContextParam);
      if (cb.invoke === "foreign") {
        if (adapter.table === null || contextParam < 0 || cb.returns !== "void") {
          throw new InternalCompilerError("emitter bug: invalid foreign FFI callback descriptor");
        }
        const dispatch = `${adapter.symbol}_dispatch`;
        const ft = ffiCallbackType(cb);
        const scriptArgs = cb.params.flatMap((param, i): string[] => {
          if (isFfiContextParam(param)) return [];
          switch (param) {
            case "f64":
              return [`scr_ffi_call_get_f64(sc_call, ${i})`];
            case "bool":
              return [`scr_ffi_call_get_bool(sc_call, ${i})`];
            case "u8":
              return [`scr_ffi_call_get_u8(sc_call, ${i})`];
            case "u32":
              return [`scr_ffi_call_get_u32(sc_call, ${i})`];
            case "i32":
              return [`scr_ffi_call_get_i32(sc_call, ${i})`];
            case "cstring":
            case "string":
              return [`scr_str_from_utf8_lossy(scr_ffi_call_get_data(sc_call, ${i}), scr_ffi_call_get_len(sc_call, ${i}))`];
            case "bytes":
              return [`scr_bytes_from_data(scr_ffi_call_get_data(sc_call, ${i}), scr_ffi_call_get_len(sc_call, ${i}))`];
          }
        });
        out.push(
          `static void ${dispatch}(ScrClosure *sc_cb, ScrFfiCall *sc_call) {`,
          `  (${cFnPtrCast(ft)}sc_cb->fn)(sc_cb${scriptArgs.length ? `, ${scriptArgs.join(", ")}` : ""});`,
          `}`,
          `static void ${adapter.symbol}(${nativeParams.join(", ")}) {`,
          `  ScrClosure *sc_cb = (ScrClosure *)sc_ctx;`,
          `  ScrFfiCall *sc_call = scr_ffi_call_new(&${adapter.table}, sc_cb, &${dispatch}, ${cb.params.length});`,
        );
        cb.params.forEach((param, i) => {
          if (isFfiContextParam(param)) return;
          switch (param) {
            case "f64":
              out.push(`  scr_ffi_call_set_f64(sc_call, ${i}, sc_a${i});`);
              break;
            case "bool":
              out.push(`  scr_ffi_call_set_bool(sc_call, ${i}, sc_a${i});`);
              break;
            case "u8":
              out.push(`  scr_ffi_call_set_u8(sc_call, ${i}, sc_a${i});`);
              break;
            case "u32":
              out.push(`  scr_ffi_call_set_u32(sc_call, ${i}, sc_a${i});`);
              break;
            case "i32":
              out.push(`  scr_ffi_call_set_i32(sc_call, ${i}, sc_a${i});`);
              break;
            case "cstring":
              out.push(`  scr_ffi_call_copy_cstring(sc_call, ${i}, sc_a${i});`);
              break;
            case "string":
            case "bytes":
              out.push(`  scr_ffi_call_copy_${param}(sc_call, ${i}, sc_a${i}, sc_a${i}_len);`);
              break;
          }
        });
        out.push(`  scr_ffi_post(sc_call);`, `}`, ``);
        continue;
      }
      out.push(
        `static ${ret} ${adapter.symbol}(${nativeParams.length > 0 ? nativeParams.join(", ") : "void"}) {`,
        `  ScrClosure *sc_cb = ${contextParam >= 0 ? `(ScrClosure *)sc_ctx` : adapter.tls ?? adapter.global};`,
        `  if (sc_cb == NULL) scr_trap("scriptc: native callback invoked outside its ${adapter.callback.lifetime === "call" ? "call-scoped" : "retained"} lifetime\\n");`,
      );
      const dummy = ffiCallbackDummyC(cb);
      out.push(`  if (scr_exc_pending()) ${cb.returns === "void" ? "return;" : `return ${dummy};`}`);
      // Reject every invalid native pointer before materializing any owned
      // callback arguments, so the trap path cannot strand an earlier copy.
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (param === "cstring") {
          out.push(
            `  if (sc_a${i} == NULL) scr_trap("scriptc: native callback passed a NULL cstring\\n");`,
          );
        } else if (param === "string" || param === "bytes") {
          out.push(
            `  if (sc_a${i} == NULL && sc_a${i}_len != 0) scr_trap("scriptc: native callback passed a NULL ${param} span with nonzero length\\n");`,
          );
        }
      }
      const ft = ffiCallbackType(cb);
      const materialized = new Map<number, string>();
      for (let i = 0; i < cb.params.length; i++) {
        const param = cb.params[i]!;
        if (isFfiContextParam(param)) continue;
        if (param === "cstring") {
          const local = `sc_s${i}`;
          out.push(
            `  ScrStr *${local} = scr_str_from_utf8_lossy((const uint8_t *)sc_a${i}, strlen(sc_a${i}));`,
          );
          materialized.set(i, local);
        } else if (param === "string") {
          const local = `sc_s${i}`;
          out.push(`  ScrStr *${local} = scr_str_from_utf8_lossy(sc_a${i}, sc_a${i}_len);`);
          materialized.set(i, local);
        } else if (param === "bytes") {
          const local = `sc_s${i}`;
          out.push(`  ScrBytes *${local} = scr_bytes_from_data(sc_a${i}, sc_a${i}_len);`);
          materialized.set(i, local);
        }
      }
      const scriptArgs = cb.params.flatMap((param, i): string[] => {
        if (isFfiContextParam(param)) return [];
        switch (param) {
          case "f64":
            return [`sc_a${i}`];
          case "bool":
            return [`(sc_a${i} != 0)`];
          case "u8":
          case "u32":
          case "i32":
            return [`(double)sc_a${i}`];
          case "cstring":
          case "string":
          case "bytes":
            return [materialized.get(i)!];
        }
      });
      const call = `(${cFnPtrCast(ft)}sc_cb->fn)(sc_cb${scriptArgs.length ? `, ${scriptArgs.join(", ")}` : ""})`;
      if (cb.lifetime === "retained") {
        // The callback may unregister or replace its own descriptor. Hold
        // one invocation reference so that dropping the table's last pin
        // cannot free the executing closure or its captures mid-call.
        out.push(`  scr_closure_retain(sc_cb);`);
      }
      if (cb.returns === "void") {
        out.push(
          `  ${call};`,
          ...(cb.lifetime === "retained" ? [`  scr_closure_release(sc_cb);`] : []),
          `  return;`,
          `}`,
          ``,
        );
        continue;
      }
      out.push(`  ${cDecl(ft.ret, "sc_result")} = ${call};`);
      if (cb.lifetime === "retained") out.push(`  scr_closure_release(sc_cb);`);
      switch (cb.returns) {
        case "f64":
          out.push(`  return sc_result;`);
          break;
        case "bool":
          out.push(`  return (uint8_t)(sc_result ? 1 : 0);`);
          break;
        case "u8":
          out.push(`  return (uint8_t)(uint32_t)scr_bit_ushr(sc_result, 0.0);`);
          break;
        case "u32":
          out.push(`  return (uint32_t)scr_bit_ushr(sc_result, 0.0);`);
          break;
        case "i32":
          out.push(`  return (int32_t)scr_bit_or(sc_result, 0.0);`);
          break;
      }
      out.push(`}`, ``);
    }
  }

  signature(fn: IrFunction): string {
    const boxedIds = new Set(fn.locals.filter((l) => l.boxed).map((l) => l.id));
    const parts = fn.params.map((p) =>
      // A boxed param's sc_l_ name is its box; the raw value arrives under
      // a sc_p_ name and is moved into the box in the prologue.
      cDecl(p.type, boxedIds.has(p.localId) ? mangleRawParam(p.localId) : mangleLocal(p.localId)),
    );
    // Lifted functions receive their closure first.
    if (fn.captures !== undefined) parts.unshift("ScrClosure *sc_env");
    const params = parts.length ? parts.join(", ") : "void";
    return `static ${cType(fn.returnType)} ${mangleFunction(fn.name)}(${params})`;
  }

  emitFunction(fn: IrFunction): void {
    return emitFunction(this, fn);
  }

  /* ── statements ───────────────────────────────────────────────────── */

  emitBlock(stmts: IrStmt[], setup?: (scope: ScopeEntry[]) => void): void {
    return emitBlock(this, stmts, setup);
  }

  emitStmts(stmts: IrStmt[]): void {
    return emitStmts(this, stmts);
  }

  emitStmt(s: IrStmt): void {
    return emitStmt(this, s);
  }

  /** A fresh loop jump-target entry. `continueLabel` null means "C
   * continue is correct" (while/forOf) — but a LABELED loop always
   * allocates one (a labeled continue arriving from a nested loop needs a
   * goto), and every labeled loop gets a lazy end label for labeled break
   * (a C break only exits the innermost loop). */
  loopTarget(continueLabel: string | null, labels: string[] | undefined): (typeof this.jumpTargets)[number] & { kind: "loop" } {
    return {
      kind: "loop",
      continueLabel: continueLabel === null && labels !== undefined ? `sc_cont_${this.labelCounter++}` : continueLabel,
      usedContinue: false,
      endLabel: labels !== undefined ? `sc_end_${this.labelCounter++}` : null,
      usedEnd: false,
      ...(labels !== undefined && { labels }),
      scopeDepth: this.scopes.length,
      frameDepth: this.frames.length,
    };
  }

  emitTryCatch(s: IrStmt & { kind: "tryCatch" }): void {
    return emitTryCatch(this, s);
  }

  emitSwitch(s: IrStmt & { kind: "switch" }): void {
    return emitSwitch(this, s);
  }

  mergeBrace(emitBlockFn: () => void): void {
    return mergeBrace(this, emitBlockFn);
  }

  emitBranchInto(target: string, expr: IrExpr): void {
    return emitBranchInto(this, target, expr);
  }

  emitCondition(cond: IrExpr): string {
    return emitCondition(this, cond);
  }

  /** C expression testing JS truthiness of a temp (falsy: 0, -0, NaN, "").
   * `x == x` rejects NaN, `x != 0` rejects both zeros; strings only need
   * their length — no runtime call, no ownership change. */
  truthyC(t: Temp): string {
    if (POINTER_KINDS.has(t.type.kind) &&
        t.type.kind !== "string" && t.type.kind !== "union" &&
        t.type.kind !== "dyn" && t.type.kind !== "jsval" &&
        t.type.kind !== "caught") {
      // JS objects are ALWAYS truthy ([] and {} included). These are
      // non-NULL pointers, so the honest constant reads as a pointer
      // test (no unused-value warnings, operand still evaluated).
      return `${t.name} != NULL`;
    }
    switch (t.type.kind) {
      case "bool":
        return t.name;
      case "f64":
        return `${t.name} == ${t.name} && ${t.name} != 0`;
      case "string":
        return `${t.name}->len != 0`;
      case "date":
        // The scalar payload may be 0 or NaN, but the source Date object
        // is always truthy.
        return "true";
      case "jsval":
        // Island truthiness: the engine's ToBoolean (never throws, no
        // ownership change) — jsval operands are legal in `logical`.
        return `(scr_jsval_truthy(${t.name}) != 0)`;
      case "union":
        // The ARM value's ToBoolean, answered by a per-union interned
        // helper (switch on tag: unit arms false, scalar/string arms by
        // value, ref arms true, jsval arms ask the engine).
        return `${this.unionTruthyHelper(t.type.unionId)}(${t.name})`;
      case "procStream":
        // A stream value is a JS object (always truthy); the scalar fd
        // representation is 1 or 2, so the honest constant reads as its
        // own non-zero test.
        return `${t.name} != 0`;
      case "dyn":
        // ToBoolean over the dyn kind (scr_dyn_truthy — JS-exact for
        // every kind; borrowed, never throws): `v || dflt` and condition
        // descent on checked-dynamic values.
        return `scr_dyn_truthy(${t.name})`;
      case "undefinedT":
      case "nullT":
      case "caught":
        throw new InternalCompilerError(`emitter bug: truthiness of ${t.type.kind}`);
      case "void":
        throw new InternalCompilerError("emitter bug: truthiness of void");
      default: {
        const _exhaustive: never = t.type as Exclude<typeof t.type, TruthyPointerType>;
        void _exhaustive;
        throw new InternalCompilerError("unreachable");
      }
    }
  }

  /* ── expressions ──────────────────────────────────────────────────── */

  emitExpr(e: IrExpr): Temp {
    return emitExpr(this, e);
  }

  childExitThunkFor(param: IrType): string {
    return childExitThunkFor(this, param);
  }

  childDataThunkFor(param: IrType): string {
    return childDataThunkFor(this, param);
  }

  closeBindThunkFor(cbUnion: IrType, retServer: boolean): string {
    return closeBindThunkFor(this, cbUnion, retServer);
  }

  closeOverrideWrapFor(cbUnion: IrType, retServer: boolean): string {
    return closeOverrideWrapFor(this, cbUnion, retServer);
  }

  childExitSignalThunkFor(codeParam: IrType, sigParam: IrType): string {
    return childExitSignalThunkFor(this, codeParam, sigParam);
  }

  dgramMsgThunkFor(param: IrType): string {
    return dgramMsgThunkFor(this, param);
  }

  dnsLookupThunkFor(cbT: IrType): string {
    return dnsLookupThunkFor(this, cbT);
  }

  fsRenameThunkFor(cbT: IrType): string {
    return fsRenameThunkFor(this, cbT);
  }

  sniAnswerThunkFor(cbT: IrType): string {
    return sniAnswerThunkFor(this, cbT);
  }

  netLookupAnswerThunkFor(cbT: IrType): string {
    return netLookupAnswerThunkFor(this, cbT);
  }

  emitterInvokeThunkFor(cbT: IrType): string {
    return emitterInvokeThunkFor(this, cbT);
  }

  streamDataThunkFor(cbT: IrType): string {
    return streamDataThunkFor(this, cbT);
  }

  streamCbThunkFor(kind: "r" | "w" | "f" | "d" | "t" | "l" | "e", cbT: IrType): string {
    return streamCbThunkFor(this, kind, cbT);
  }

  connectSockThunkFor(cbT: IrType): string {
    return connectSockThunkFor(this, cbT);
  }
  connectResThunkFor(cbT: IrType): string {
    return connectResThunkFor(this, cbT);
  }

  raceAdapterFor(from: IrType, to: IrType): string {
    return raceAdapterFor(this, from, to);
  }

  resolveThunkFor(inner: IrType): string {
    return resolveThunkFor(this, inner);
  }
}
