/* LlEmitter's function emission: function bodies, generator and async scaffolding, async awaits, WASI fulfillment and trampolines. */
import {
  type LlArgPackAndTrampolinePrologue,
  type LlEmitter,
  type LlScopeEntry,
  SUSPENDS,
  UNOPTIMIZED_BOX_SLOTS,
  boxSlotCount,
} from "./emitter.js";
import { type IrFunction, type IrType, isRefCounted, typeKey } from "../../ir/ir.js";
import { BlockBuilder } from "./blocks.js";
import { findPrivateSplitLocals } from "./split-loops.js";
import {
  conditionalLoopWrites,
  initializerLocalCandidates,
  withInitializerBindings,
  withInitializerLocals,
} from "../../ir/initializer-bindings.js";
import { constructorClass } from "../../ir/final-fields.js";
import { findLoopArrayBorrows } from "./loop-array-borrows.js";
import { findCallArrayReads, findLocalArrayReads } from "./local-array-reads.js";
import { findScalarStringSlices, findScratchStringSlices } from "./string-slices.js";
import {
  findMapReadBorrows,
  findMapReadLifetimes,
  findReadNumberMapWrites,
} from "./map-read-lifetimes.js";
import { borrowableMapGet } from "./expr-containers.js";
import { findMapEntryFusions } from "./map-entry-fusion.js";
import { findLocalStackUnions } from "./stack-unions.js";
import { findLocalStackObjects, findReassignedStackObjects } from "./stack-objects.js";
import { findLocalUnionStorage } from "./local-union-storage.js";
import { INT32_RANGE, analyzeIntegerRangeFacts } from "../../ir/integer-ranges.js";
import { beginLoopEntryVersions } from "./loop-entry-versions.js";
import { findBytesBounds } from "./bytes-bounds.js";
import { findInt32Locals } from "./int32-locals.js";
import { findIntegerViews } from "./integer-views.js";
import {
  mangleArgPack,
  mangleAsyncAdoptCall,
  mangleAsyncAwaitCall,
  mangleAsyncDirectSpawn,
  mangleAsyncSpawn,
  mangleBorrowedFunction,
  mangleClassStruct,
  mangleFunction,
  mangleGenDrop,
  mangleGenSourceClose,
  mangleGenSpawn,
  mangleGlobal,
  mangleLocal,
  mangleTrampoline,
} from "../mangle.js";
import { InternalCompilerError } from "../../errors.js";
import { classEnvironmentIndex } from "./classes.js";
import { FN_ATTRS, boxNewCall, releaseSym, traceArg, vAdapters } from "./shapes.js";
import type { LlValue } from "./expr-context.js";
import { INT32_ABI_SUFFIX, SCALAR_UNION_RESULT } from "./int32-abi.js";
import { f64Lit } from "./common.js";
import { RESULT_ENTRY_PREFIX } from "./record-results.js";
import { emitIntegerClone, emitIntegerDispatcher } from "./integer-clones.js";
import { beginFunctionLoops, LOOPS } from "./loop-state.js";
import { runningExtremumUpdates } from "./running-extrema.js";
import { findIntegerOrNaNLocals } from "./wrapping-sums.js";
import { UNWIND_PERSONALITY, UNWIND_SLOT } from "./unwind-abi.js";

export function emitFunction(emitter: LlEmitter, fn: IrFunction): string {
  const B = new BlockBuilder();
  emitter.B = B;
  emitter.currentFunctionName = fn.name;
  emitter.currentUnwindAbi = emitter.unwindAbi.has(fn.name);
  emitter.usesLandingPads = false;
  emitter.aliasScopedVersions = 0;
  emitter.findInt32Allocations(fn);
  emitter.speculativeLeaves = 0;
  emitter.currentTier = fn.tier;
  // Fiber switches restore the active exception cell before control
  // returns to a synchronous frame (emitPendingCheck).
  B.excCellInvariant = fn.async !== true && fn.generator === undefined;
  emitter.debugScope = emitter.debug?.function(fn) ?? null;
  B.debugLocation = emitter.debug?.location(fn.loc, emitter.debugScope) ?? null;
  emitter.frames = [];
  emitter.scopes = [];
  emitter.unwindCleanups.clear();
  emitter.jumpTargets = [];
  emitter.currentLocals = new Map(fn.locals.map((l) => [l.id, l]));
  emitter.currentParameters = new Set(fn.params.map((p) => p.localId));
  emitter.lazyCaptureBoxes.clear();
  emitter.lazyStackBoxes.clear();
  // An unchanged captured parameter keeps its value in a plain slot; the
  // binding is boxed only for closures (captureBox).
  const lazyParameters = emitter.lazyCaptures.parameters(fn);
  for (const id of lazyParameters) {
    const { boxed: _boxed, ...plain } = emitter.currentLocals.get(id)!;
    emitter.currentLocals.set(id, plain);
    emitter.lazyCaptureBoxes.set(id, "");
  }
  emitter.runningExtrema = emitter.debug === null ? runningExtremumUpdates(fn) : new Set();
  emitter.currentConstantCallbacks =
    emitter.debug === null ? (emitter.constantCallbacks.get(fn.name) ?? new Map()) : new Map();
  emitter.knownCallbacks.clear();
  emitter.callbackVersionsEnabled = emitter.debug === null && !fn.async && !fn.generator;
  // Preserve concrete source bindings for debugger inspection. Suspended
  // functions keep the established array lifetime across continuations.
  emitter.streamingSplitsEnabled = emitter.debug === null && !fn.async && !fn.generator;
  emitter.stackCallbacks.reset(emitter.streamingSplitsEnabled);
  emitter.stackCaptures.reset(fn, emitter.streamingSplitsEnabled, lazyParameters);
  emitter.privateSplitLocals = emitter.streamingSplitsEnabled
    ? findPrivateSplitLocals(fn)
    : new Map();
  emitter.storedSplits.clear();
  emitter.splitSpans.clear();
  emitter.stringSlices.clear();
  const initializerBindings = emitter.initializerBindings.get(fn.name) ?? [];
  const numericFn = withInitializerBindings(fn, initializerBindings);
  emitter.numericLocals = new Map(numericFn.locals.map((l) => [l.id, l]));
  emitter.borrowedParameters.clear();
  emitter.referenceWrites?.enter(fn);
  emitter.reboundOwnerSlots.clear();
  emitter.projectedParameters.clear();
  const projectedParameterIndexes = emitter.callLifetimes.parameters.get(fn.name);
  if (projectedParameterIndexes)
    for (const index of projectedParameterIndexes)
      emitter.projectedParameters.add(fn.params[index]!.localId);
  emitter.stableCallBindings = emitter.callLifetimes.bindings.get(fn.name) ?? new Set();
  const borrowedParameterIndexes = emitter.callLifetimes.borrowed.get(fn.name);
  if (borrowedParameterIndexes) {
    // Rebound walk parameters borrow too, but only unchanged ones may
    // serve as stable owners for call arguments and aliases.
    for (const index of borrowedParameterIndexes)
      if (
        !emitter.walkBorrowsByFunction.get(fn.name)?.has(fn.params[index]!.localId) &&
        !emitter.reboundByFunction.get(fn.name)?.has(fn.params[index]!.localId)
      )
        emitter.borrowedParameters.add(fn.params[index]!.localId);
  }
  // A generator frame owns its unchanged parameters across suspensions.
  const generatorParameters = emitter.callLifetimes.generatorParameters.get(fn.name);
  if (generatorParameters !== undefined)
    for (const id of generatorParameters) emitter.borrowedParameters.add(id);
  emitter.captureIds = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  emitter.stableCaptureIds =
    fn.captures !== undefined ? emitter.lazyCaptures.stableCaptures(fn.name) : new Set();
  emitter.integerLoopBindings.clear();
  emitter.integerTemps.clear();
  emitter.integerTempsEnabled = emitter.debug === null && !fn.async && !fn.generator;
  beginFunctionLoops(emitter, fn, numericFn);
  emitter.speculativeLoopsEnabled = LOOPS.of(emitter).countedLoopsEnabled;
  emitter.loopCopiesEnabled = true;
  emitter.speculativeFunction = fn.name;
  emitter.speculation = null;
  emitter.speculationResume = null;
  emitter.int32Kinds = null;
  emitter.int32KindResume = null;
  emitter.finalFieldBorrows =
    !fn.async &&
    !fn.generator &&
    constructorClass(fn.name) === null &&
    emitter.finalFields.size > 0;
  emitter.integerViews.clear();
  emitter.orderedViews.clear();
  emitter.fieldPointerTags.clear();
  emitter.compressedFieldPtrs.clear();
  emitter.integerArrayBindings.clear();
  emitter.loopArrayBorrows =
    emitter.debug === null
      ? findLoopArrayBorrows(
          fn,
          emitter.callLifetimes,
          emitter.referenceEffects,
          emitter.optionalArrayReads,
          emitter.referenceWrites,
          emitter.fnByName,
          emitter.nodeIndex,
        )
      : new Set();
  emitter.localArrayReads = findLocalArrayReads(
    fn,
    emitter.fnByName,
    emitter.unionsById,
    emitter.referenceEffects.functions,
    emitter.callLifetimes,
    emitter.optionalArrayReads,
    emitter.loopArrayBorrows,
    emitter.debug === null ? emitter.referenceEffects : undefined,
  );
  emitter.callArrayReads = findCallArrayReads(
    fn,
    emitter.optionalArrayReads,
    emitter.referenceEffects.functions,
    emitter.callLifetimes,
    emitter.debug === null ? emitter.referenceEffects : undefined,
  );
  emitter.scalarStringSlices =
    emitter.debug === null ? findScalarStringSlices(fn, emitter.callLifetimes) : new Map();
  emitter.scratchStringSlices =
    emitter.debug === null
      ? findScratchStringSlices(
          fn,
          emitter.callLifetimes,
          emitter.scalarStringSlices,
          emitter.lendingFacts,
        )
      : new Set();
  emitter.mapReadLifetimes = findMapReadLifetimes(
    fn,
    emitter.boxedUnionsById,
    emitter.callLifetimes,
    emitter.referenceEffects,
  );
  const stable = emitter.callLifetimes.bindings.get(fn.name);
  emitter.borrowedMapGets = findMapReadBorrows(
    fn,
    emitter.referenceEffects,
    (decl) =>
      decl.init !== null &&
      stable?.has(decl.localId) === true &&
      !emitter.mapReadLifetimes.locals.has(decl.localId) &&
      borrowableMapGet(emitter, decl.init),
  );
  emitter.readNumberMapWrites = findReadNumberMapWrites(fn);
  emitter.numberMapKeyIntegers = new Map();
  emitter.mapEntryFusion = emitter.debug === null ? findMapEntryFusions(fn) : null;
  emitter.localStackUnions = findLocalStackUnions(
    fn,
    emitter.callLifetimes,
    emitter.boxedUnionsById,
  );
  emitter.localStackObjects = emitter.stackObjects
    ? findLocalStackObjects(emitter, fn, emitter.callLifetimes)
    : new Map();
  emitter.reassignedStackObjects = emitter.stackObjects
    ? findReassignedStackObjects(emitter, fn, emitter.callLifetimes)
    : new Set();
  emitter.stackObjectSlots = new Map();
  emitter.stackObjectFieldPtrs = new Map();
  emitter.localUnionStorageProofs = findLocalUnionStorage(
    fn,
    emitter.callLifetimes,
    emitter.unionSources,
  );
  emitter.localUnionStorage = new Map();
  emitter.walkBorrows = emitter.walkBorrowsByFunction.get(fn.name) ?? new Set();
  const slotFacts = emitter.int32Slots.facts(fn.name);
  const rangeFacts = analyzeIntegerRangeFacts(numericFn, slotFacts);
  emitter.integerRanges = rangeFacts.ranges;
  emitter.integerLoopRanges = rangeFacts.loopRanges;
  beginLoopEntryVersions(emitter, numericFn, slotFacts, rangeFacts);
  emitter.int32Elements = slotFacts.elements ?? null;
  emitter.integerOrNaNLocals = findIntegerOrNaNLocals(emitter, numericFn);
  emitter.bytesBounds = findBytesBounds(numericFn, emitter.integerRanges);
  emitter.bytesOwned = new Set();
  // Debug builds keep every number local a double for the debugger's
  // variable view. Lazily boxed captured parameters keep their double,
  // which the box is created from, and so do plain copies of a capture or
  // such a parameter (copyStableCaptures): the source already holds the
  // double, which an i32 copy would convert and widen again on every call.
  // Initializer bindings proven int32 move into an i32 local of their
  // initializer: no other code observes the global, so the loop-carried
  // value never round-trips through the double slot.
  const initializerLocals = initializerLocalCandidates(initializerBindings);
  const int32Locals =
    emitter.debug === null
      ? findInt32Locals(
          withInitializerLocals(fn, initializerLocals),
          emitter.integerRanges,
          emitter.int32Slots.facts(fn.name),
          new Set([...emitter.lazyCaptureBoxes.keys(), ...emitter.doubleCopies(fn)]),
        )
      : null;
  emitter.int32Locals = int32Locals?.locals ?? new Map();
  emitter.int32LocalWrites = int32Locals?.values ?? new Set();
  const localizedGlobals = new Set<string>();
  for (const global of initializerLocals) {
    if (!emitter.int32Locals.has(global.id)) continue;
    localizedGlobals.add(global.id);
    emitter.currentLocals.set(global.id, {
      id: global.id,
      name: global.name,
      type: global.type,
      mutable: global.mutable,
    });
  }
  emitter.chainSlots.clear();
  emitter.finallyStack = [];
  emitter.tryStack = [];
  emitter.loopDepth = 0;
  emitter.currentReturnType = fn.returnType;
  const int32Abi = emitter.int32Abis.get(fn.name);
  emitter.currentInt32Result = int32Abi?.result === true;
  emitter.currentUnionResult = int32Abi?.union === true;
  emitter.currentGenerator = fn.generator ?? null;
  emitter.currentAsyncGenerator = fn.async === true && fn.generator !== undefined;
  emitter.currentBorrowedReturn = emitter.borrowedReturns.has(fn.name);
  emitter.lastUseMoves.clear();
  emitter.varRefCounts = null;
  emitter.currentFunctionBody = fn.body;
  emitter.inConstructor = emitter.constructorFunctions.has(fn.name);
  emitter.currentCoro = null;
  emitter.logArgSlots = 0;

  if (emitter.coroLowered(fn)) {
    emitter.usesCoroutines = true;
    emitter.declare(`declare token @llvm.coro.id(i32, ptr, ptr, ptr)`);
    emitter.declare(`declare ${emitter.sizeType} @llvm.coro.size.${emitter.sizeType}()`);
    emitter.declare(`declare ptr @llvm.coro.begin(token, ptr)`);
    emitter.declare(`declare token @llvm.coro.save(ptr)`);
    emitter.declare(`declare i8 @llvm.coro.suspend(token, i1)`);
    emitter.declare(`declare ptr @llvm.coro.free(token, ptr)`);
    emitter.declare(`declare void @llvm.coro.end(ptr, i1, token)`);
    // Native frames come from the runtime's small-block allocator.
    const frameAlloc = emitter.wasi ? "malloc" : "scr_rt_calloc";
    emitter.declare(`declare ptr @${frameAlloc}(${emitter.sizeType})`);
    emitter.declare(`declare void @${emitter.wasi ? "free" : "scr_rt_free"}(ptr)`);
    const started = emitter.wasi ? "scr_wasi_coro_started" : "scr_coro_started";
    emitter.declare(`declare void @${started}(ptr)`);
    emitter.declare(`declare ptr @scr_fiber_self()`);
    const id = B.tmp();
    const size = B.tmp();
    const mem = B.tmp();
    const handle = B.tmp();
    const self = B.tmp();
    B.line(`${id} = call token @llvm.coro.id(i32 0, ptr null, ptr null, ptr null)`);
    B.line(`${size} = call ${emitter.sizeType} @llvm.coro.size.${emitter.sizeType}()`);
    B.line(`${mem} = call ptr @${frameAlloc}(${emitter.sizeType} ${size})`);
    B.line(`${handle} = call ptr @llvm.coro.begin(token ${id}, ptr ${mem})`);
    B.line(`call void @${started}(ptr ${handle})`);
    B.line(`${self} = call ptr @scr_fiber_self()`);
    // A native synchronous body owns its generator for the whole run (the
    // ScrGen owns the frame), so its OUT slot address is fixed.
    let out: string | null = null;
    const yieldKind = fn.generator?.yieldT.kind;
    if (!emitter.wasi && fn.async !== true && (yieldKind === "f64" || yieldKind === "bool")) {
      emitter.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
      const gen = B.tmp();
      B.line(`${gen} = call ptr @scr_gen_of_fiber(ptr ${self})`);
      out = emitter.genOutSlot(gen);
    }
    emitter.currentCoro = {
      kind: fn.generator !== undefined ? "generator" : "async",
      awaits: fn.async === true,
      id,
      handle,
      self,
      finalLabel: B.newLabel("coro.final"),
      cleanupLabel: B.newLabel("coro.cleanup"),
      suspendLabel: B.newLabel("coro.suspend"),
      out,
    };
  }

  const paramIds = new Set(fn.params.map((p) => p.localId));
  if (emitter.debug === null) {
    for (const id of findIntegerViews(numericFn, emitter.nodeIndex)) {
      // An i32 slot is its own view.
      if (emitter.int32Locals.has(id)) continue;
      const slot = B.slot();
      B.entryAllocas.push(
        `${slot} = alloca i32 ; integer view ${emitter.numericLocals.get(id)!.name}`,
      );
      emitter.integerViews.set(id, slot);
      // A local of exact integers or NaN also keeps whether it is NaN, so
      // its integer is usable without converting the double.
      if (emitter.integerOrNaNLocals.has(id)) {
        const ordered = B.slot();
        B.entryAllocas.push(
          `${ordered} = alloca i1 ; ordered view ${emitter.numericLocals.get(id)!.name}`,
        );
        emitter.orderedViews.set(id, ordered);
      }
    }
  }
  for (const global of initializerBindings) {
    if (!emitter.integerViews.has(global.id)) continue;
    const value = B.tmp();
    B.line(`${value} = load double, ptr @${mangleGlobal(global.id)}`);
    emitter.storeIntegerView(global.id, { name: value, type: global.type });
  }
  // A number global only its guarded, synchronous initializer reads or
  // writes (findInitializerBindings) is invisible to every other function,
  // and reentry returns before reaching it, so a local slot can stand in
  // for it: LLVM keeps it in a register across calls and loops that would
  // otherwise force a store and reload per iteration. The global's
  // storage is never read again, so nothing writes the slot back. Bindings
  // proven int32 already live in an i32 local (localizedGlobals above);
  // this covers the remaining doubles.
  emitter.privateGlobalSlots.clear();
  if (emitter.debug === null && emitter.currentCoro === null && !fn.async && !fn.generator) {
    const conditional = initializerLocals.length ? conditionalLoopWrites(fn.body) : null;
    for (const global of initializerLocals) {
      if (localizedGlobals.has(global.id)) continue;
      // A conditional update in a loop stays a memory update (see
      // conditionalLoopWrites).
      if (conditional?.has(global.id)) continue;
      const slot = B.slot();
      const value = B.tmp();
      B.entryAllocas.push(`${slot} = alloca double ; module binding ${global.name}`);
      B.line(`${value} = load double, ptr @${mangleGlobal(global.id)}`);
      B.line(`store double ${value}, ptr ${slot}`);
      emitter.privateGlobalSlots.set(global.id, slot);
    }
  }
  for (const local of emitter.currentLocals.values()) {
    // Boxed locals' slots hold their capture BOX (a ptr); captured
    // (env-borrowed) locals bind the incoming box below. A caught-typed
    // local is a catch binding: its slot holds the ScrCaught snapshot
    // box the catch prologue takes (scr_exc_take).
    const slotTy =
      local.boxed || emitter.captureIds.has(local.id) || local.type.kind === "caught"
        ? "ptr"
        : emitter.int32Locals.has(local.id)
          ? "i32"
          : emitter.llType(local.type);
    B.entryAllocas.push(`%${mangleLocal(local.id)} = alloca ${slotTy} ; ${local.name}`);
    emitter.emitDebugLocal(
      local,
      `%${mangleLocal(local.id)}`,
      fn.params.findIndex((p) => p.localId === local.id) + 1,
      emitter.captureIds.has(local.id),
    );
    // A localized initializer binding starts at its global's zero value.
    if (localizedGlobals.has(local.id)) B.line(`store i32 0, ptr %${mangleLocal(local.id)}`);
    // Refcounted/boxed locals start NULL (the C prologue's `= NULL`):
    // scope-exit releases run whether or not an assign ever did.
    if (paramIds.has(local.id) || emitter.captureIds.has(local.id)) continue;
    if (local.boxed || isRefCounted(local.type)) {
      B.line(`store ptr null, ptr %${mangleLocal(local.id)}`);
    }
  }
  // A body holding thousands of capture boxes compiles unoptimized, its
  // box pointers kept in their slots (see boxSlotCount).
  const unoptimized = emitter.currentCoro === null && boxSlotCount(fn) >= UNOPTIMIZED_BOX_SLOTS;
  if (unoptimized) {
    const slots = new Set<string>();
    for (const local of emitter.currentLocals.values())
      if (local.boxed || emitter.captureIds.has(local.id)) slots.add(`%${mangleLocal(local.id)}`);
    B.volatileSlots = slots;
    // Without optimization a versioned copy only adds code.
    LOOPS.of(emitter).bytesLoopVersionsEnabled = false;
  }
  // Captured bindings come in through the environment — borrowed for the
  // whole call (the closure owns them): bound here, never released here.
  (fn.captures ?? []).forEach((c, i) => {
    const caps = B.tmp();
    const p = B.tmp();
    const box = B.tmp();
    B.line(`${caps} = getelementptr inbounds %ScrClosure, ptr %sc_env, i64 1 ; caps`);
    B.line(`${p} = getelementptr inbounds ptr, ptr ${caps}, ${emitter.sizeType} ${i} ; caps[${i}]`);
    B.line(`${box} = load ptr, ptr ${p}`);
    B.line(`store ptr ${box}, ptr %${mangleLocal(c.localId)} ; captured ${c.name}`);
  });
  (fn.classCaptures ?? []).forEach((c) => {
    const self = fn.params[0]!;
    if (self.type.kind !== "object")
      throw new InternalCompilerError("class captures require an instance receiver");
    const classSlot = B.tmp();
    const classValue = B.tmp();
    const caps = B.tmp();
    const slot = B.tmp();
    const box = B.tmp();
    B.line(
      `${classSlot} = getelementptr inbounds %${mangleClassStruct(self.type.className)}, ptr %p_${mangleLocal(self.localId)}, i64 0, i32 ${classEnvironmentIndex(emitter.classMeta.get(self.type.className)!)}`,
    );
    B.line(`${classValue} = load ptr, ptr ${classSlot}`);
    B.line(`${caps} = getelementptr inbounds %ScrClassObj, ptr ${classValue}, i64 1`);
    B.line(`${slot} = getelementptr inbounds ptr, ptr ${caps}, ${emitter.sizeType} ${c.slot}`);
    B.line(`${box} = load ptr, ptr ${slot}`);
    B.line(`store ptr ${box}, ptr %${mangleLocal(c.localId)} ; class capture ${c.name}`);
  });
  // Params spill into their slots; the function scope owns refcounted
  // params (callees own their params — callers passed +1). Boxed params
  // allocate the shared binding and move the raw value in.
  const fnScope: LlScopeEntry[] = [];
  for (const id of emitter.lazyCaptureBoxes.keys()) {
    const cache = B.slot();
    B.entryAllocas.push(`${cache} = alloca ptr ; lazy box ${emitter.currentLocals.get(id)!.name}`);
    B.line(`store ptr null, ptr ${cache}`);
    fnScope.push({
      slot: cache,
      type: emitter.currentLocals.get(id)!.type,
      boxed: true,
      lazy: true,
    });
    emitter.lazyCaptureBoxes.set(id, cache);
    // Environments that finish during the call can share an immortal
    // frame box. Its payload owner is released with the function scope.
    const stack = emitter.stackCaptures.emit(emitter, id, emitter.currentLocals.get(id)!.type);
    if (stack) {
      emitter.lazyStackBoxes.set(id, stack.box);
      if (stack.owner) fnScope.push(stack.owner);
    }
  }
  const borrowed = emitter.callLifetimes.borrowed.get(fn.name);
  for (const [index, p] of fn.params.entries()) {
    const local = emitter.currentLocals.get(p.localId)!;
    const slot = `%${mangleLocal(p.localId)}`;
    if (local.boxed) {
      const box = B.tmp();
      B.line(`${box} = ${boxNewCall(emitter.shapeHost, p.type)} ; ${p.name} (boxed param)`);
      emitter.boxSet(box, p.type, `%p_${mangleLocal(p.localId)}`);
      B.line(`store ptr ${box}, ptr ${slot}`);
      fnScope.push({ slot, type: p.type, boxed: true });
      continue;
    }
    const incoming: LlValue = { name: `%p_${mangleLocal(p.localId)}`, type: p.type };
    if (int32Abi?.params[index]) {
      const bits = `%p_${mangleLocal(p.localId)}${INT32_ABI_SUFFIX}`;
      incoming.uint32 = bits;
      incoming.integer = { name: bits, type: "i32", signed: true, range: INT32_RANGE };
    }
    if (emitter.storeInt32Local(p.localId, incoming)) continue;
    B.line(`store ${emitter.llType(p.type)} %p_${mangleLocal(p.localId)}, ptr ${slot}`);
    emitter.storeIntegerView(p.localId, incoming);
    if (isRefCounted(p.type) && !borrowed?.has(index)) {
      fnScope.push({ slot, type: p.type });
      emitter.noteParameterMove(fn, p.localId, slot);
    }
    if (emitter.reboundByFunction.get(fn.name)?.has(p.localId) && borrowed?.has(index)) {
      // The caller's borrow stays in the parameter slot; values the body
      // assigns are owned here until rebinding or exit releases them.
      const owner = `${slot}.owner`;
      B.entryAllocas.push(`${owner} = alloca ptr`);
      B.line(`store ptr null, ptr ${owner}`);
      fnScope.push({ slot: owner, type: p.type });
      emitter.reboundOwnerSlots.set(p.localId, owner);
    }
  }
  emitter.scopes.push(fnScope);
  emitter.beginArenaFunction(fn);
  // Stackful native fibers and native coroutine frames retain these frames
  // while suspended. The active exception context owns the chain, so
  // concurrent fibers isolate it.
  if (
    emitter.stackTraces &&
    !emitter.wasi &&
    fn.sourceName !== undefined &&
    !emitter.unframedFunctions.has(fn.name)
  ) {
    B.entryAllocas.push(`%source_frame = alloca { ptr, ptr }`);
    const frame = emitter.cstr(`    at ${fn.sourceName} (${fn.loc.file})`);
    if (
      B.excCellInvariant &&
      emitter.mod.lib === undefined &&
      emitter.mod.workers !== true &&
      emitter.sizeType === "i64"
    ) {
      // Executables link the active-cell pointer as a plain global, and a
      // synchronous body sees one cell from entry to every return: push
      // and pop the frame inline (ScrExcCell.stack is at byte 56 on
      // 64-bit targets) instead of calling the runtime twice per call.
      emitter.declare(`@scr_exc_active = external global ptr`);
      B.line(`%source_frame.cell = load ptr, ptr @scr_exc_active`);
      B.line(`%source_frame.chain = getelementptr inbounds i8, ptr %source_frame.cell, i64 56`);
      B.line(`%source_frame.previous = load ptr, ptr %source_frame.chain`);
      B.line(`store ptr %source_frame.previous, ptr %source_frame`);
      B.line(`%source_frame.text = getelementptr inbounds i8, ptr %source_frame, i64 8`);
      B.line(`store ptr ${frame}, ptr %source_frame.text`);
      B.line(`store ptr %source_frame, ptr %source_frame.chain`);
      B.returnEpilogue = `store ptr %source_frame.previous, ptr %source_frame.chain`;
    } else {
      emitter.declare(`declare void @scr_stack_enter(ptr, ptr)`);
      emitter.declare(`declare void @scr_stack_leave(ptr)`);
      B.line(`call void @scr_stack_enter(ptr %source_frame, ptr ${frame})`);
      B.returnEpilogue = `call void @scr_stack_leave(ptr %source_frame)`;
    }
  }
  if (emitter.stackChecks?.has(fn.name)) emitter.emitStackCheck();
  if (emitter.workerEntryPolls?.has(fn.name)) emitter.emitPendingCheck(undefined, true);
  emitter.emitStmts(fn.body, true);
  // Implicit exit of a void function: release the function scope unless
  // the body already terminated its final block (return, or a throw
  // whose unwind released everything down to depth 0).
  if (fn.returnType.kind === "void" && !B.isTerminated()) {
    emitter.releaseScope(emitter.scopes[0]!);
    // Completing by falling off the end has nothing to await.
    if (emitter.currentAsyncGenerator) emitter.emitAsyncGenSettled();
    if (emitter.currentCoro !== null) {
      emitter.emitWasiFulfill(null);
      B.terminate(`br label %${emitter.currentCoro.finalLabel}`);
    } else {
      B.terminate("ret void");
    }
  }
  emitter.scopes.pop();

  const coro = emitter.currentCoro;
  if (coro !== null) {
    B.startBlock(coro.finalLabel);
    // Every exit of a coroutine body joins here: its source frame (part
    // of the coroutine frame) leaves the generator's own chain.
    const epilogue = B.returnEpilogue;
    B.returnEpilogue = null;
    if (epilogue !== null) B.line(epilogue);
    if (fn.captures !== undefined) {
      emitter.declare(`declare void @scr_closure_release(ptr)`);
      B.line(`call void @scr_closure_release(ptr %sc_env)`);
    }
    if (coro.kind === "generator") {
      const finish = emitter.wasi ? "scr_wasi_gen_finish" : "scr_gen_coro_finish";
      emitter.declare(`declare void @${finish}(ptr)`);
      B.line(`call void @${finish}(ptr ${coro.self})`);
    } else {
      const finish = emitter.wasi ? "scr_wasi_async_finish" : "scr_coro_async_finish";
      emitter.declare(`declare void @${finish}(ptr)`);
      B.line(`call void @${finish}(ptr ${coro.self})`);
    }
    const finalState = B.tmp();
    B.line(`${finalState} = call i8 @llvm.coro.suspend(token none, i1 true)`);
    B.terminate(
      `switch i8 ${finalState}, label %${coro.suspendLabel} [ i8 1, label %${coro.cleanupLabel} ]`,
    );
    B.startBlock(coro.cleanupLabel);
    const frame = B.tmp();
    B.line(`${frame} = call ptr @llvm.coro.free(token ${coro.id}, ptr ${coro.handle})`);
    B.line(`call void @${emitter.wasi ? "free" : "scr_rt_free"}(ptr ${frame})`);
    B.br(coro.suspendLabel);
    B.startBlock(coro.suspendLabel);
    B.line(`call void @llvm.coro.end(ptr ${coro.handle}, i1 false, token none)`);
    const ret = emitter.llType(fn.returnType);
    if (ret === "void") B.terminate(`ret void`);
    else if (ret === "double") B.terminate(`ret double ${f64Lit(0)}`);
    else if (ret === "i1") B.terminate(`ret i1 false`);
    else B.terminate(`ret ptr null`);
  }

  // Shared blocks have multiple source locations. Keep the location on
  // each incoming exception check instead of assigning one to the cleanup.
  B.debugLocation = null;
  for (const cleanup of emitter.unwindCleanups.values()) {
    B.startBlock(cleanup.label);
    emitter.releaseScope(cleanup.entries);
    B.terminate(cleanup.terminator);
  }

  if (emitter.usesLandingPads && emitter.currentUnwindAbi)
    B.entryAllocas.push(`${UNWIND_SLOT} = alloca { ptr, i32 }`);
  if (emitter.logArgSlots > 0) {
    B.entryAllocas.push(`%logargs = alloca [${emitter.logArgSlots} x %ScrLogArg]`);
  }
  const params = fn.params.map((p, index) =>
    int32Abi?.params[index]
      ? `i32 %p_${mangleLocal(p.localId)}${INT32_ABI_SUFFIX}`
      : `${emitter.llType(p.type)} %p_${mangleLocal(p.localId)}`,
  );
  // The i32 entry widens its i32 parameters once; the proof makes the
  // double exact, so readers of the incoming number see the same value.
  if (int32Abi)
    fn.params.forEach((p, index) => {
      if (!int32Abi.params[index]) return;
      const name = `%p_${mangleLocal(p.localId)}`;
      B.entryAllocas.push(`${name} = sitofp i32 ${name}${INT32_ABI_SUFFIX} to double`);
    });
  // Lifted functions receive their closure first (the callValue ABI).
  if (fn.captures !== undefined) params.unshift("ptr %sc_env");
  const ret = int32Abi?.result
    ? "i32"
    : int32Abi?.union
      ? SCALAR_UNION_RESULT
      : emitter.llType(fn.returnType);
  let attrs = coro !== null ? "#1" : FN_ATTRS;
  // The shared indexed-read helper (lowerSafeIndexRead) is a dense bounds
  // test, a state test and a load behind cold runtime fallbacks, called
  // from every `a[i]` of one element type. Without the hint LLVM keeps the
  // hot instances out of line once they have many callers: every read pays
  // a call, and an integer index converts to a double and back across it.
  if (fn.name.startsWith("%arr.idxOr.")) attrs = `inlinehint ${attrs}`;
  // Interface dispatch is a few key tests and direct calls ahead of the
  // checked dynamic call. Keeping that fallback out of line leaves the
  // tests small enough to inline at each call site.
  if (fn.name.startsWith("%dyn.class.protocol.fallback.")) attrs = `noinline ${attrs}`;
  // A keyed record read's inherited-method miss path (record-inherited.ts)
  // stays out of line, so the hit path keeps its own small frame.
  else if (fn.name.startsWith("%rec.inherited.")) attrs = `noinline cold ${attrs}`;
  else if (fn.name.startsWith("%dyn.class.protocol.")) attrs = `inlinehint ${attrs}`;
  if (fn.name.startsWith(RESULT_ENTRY_PREFIX)) attrs = `inlinehint ${attrs}`;
  if (unoptimized && attrs === FN_ATTRS) attrs = `noinline optnone ${attrs}`;
  const debug = emitter.debugScope === null ? "" : ` !dbg ${emitter.debugScope}`;
  const symbol = borrowed ? mangleBorrowedFunction(fn.name) : mangleFunction(fn.name);
  emitter.privateGlobalSlots.clear();
  // Landing pads (emitDirectCall) need the personality.
  const personality = emitter.usesLandingPads ? ` ${UNWIND_PERSONALITY}` : "";
  if (emitter.usesLandingPads) emitter.declare(`declare i32 @__gcc_personality_v0(...)`);
  let body = `define internal ${ret} @${symbol}${int32Abi ? INT32_ABI_SUFFIX : ""}(${params.join(", ")}) ${attrs}${personality}${debug} { ; ${fn.name}\n${B.render()}\n}`;
  if (int32Abi) body += "\n" + emitter.emitInt32AbiWrapper(fn, symbol, int32Abi);
  if (emitter.integerClones.members.has(fn.name)) {
    body += "\n" + emitIntegerClone(fn, emitter, emitter.stackChecks?.has(fn.name) === true);
    if (emitter.integerClones.dispatched.has(fn.name))
      body +=
        "\n" +
        emitIntegerDispatcher(
          fn,
          emitter,
          `${symbol}${int32Abi ? INT32_ABI_SUFFIX : ""}`,
          int32Abi?.params ?? [],
          int32Abi?.result === true,
        );
  }
  if (!borrowed) return body;
  const slot = emitter.implSlotBorrowed(fn.name);
  const virtual =
    slot.size > 0 && slot.size !== borrowed.size
      ? "\n" + emitter.emitOwnedCallAdapter(fn, borrowed, slot)
      : "";
  return body + "\n" + emitter.emitOwnedCallAdapter(fn, borrowed) + virtual;
}

/** Per-generator-function machinery — the async scaffolding's lazy
 * sibling (async.ts's emitGenScaffolding): the same argument pack,
 * a fiber trampoline whose epilogue stores the COMPLETION value (or
 * consumes the GENRET sentinel, promoting the parked .return value), a
 * spawn wrapper that only ALLOCATES the suspended fiber, and the
 * never-started teardown that drops the packed (+1) arguments. */
export function emitGenScaffolding(emitter: LlEmitter): string[] {
  const out: string[] = [];
  for (const fn of emitter.mod.functions) {
    if (fn.generator === undefined) continue;
    const { definitions, pack, lifted, fieldTys, ret, tr, spawnParams, argPackLines } =
      emitter.emitArgPackAndTrampolinePrologue(fn);
    for (const line of definitions) out.push(line);
    emitter.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
    emitter.declare(`declare void @scr_exc_clear()`);
    emitter.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
    emitter.declare(`declare void @scr_gen_ret_to_out(ptr)`);
    emitter.declare(`declare ptr @scr_gen_new(ptr, ptr, ptr)`);
    emitter.needOom();
    const coroBody = emitter.coroLowered(fn);
    if (lifted && !coroBody) {
      emitter.declare(`declare void @scr_closure_release(ptr)`);
    }
    // Normal completion stores the (typed) return value; void completes
    // with the NONE slot — JS's undefined done-value. A GENRET unwind
    // consumes the sentinel and promotes the parked .return value; a
    // real exception stays pending (the consumer-side resume moves it).
    if (coroBody) {
      tr.push(`  ret void`, `}`, ``);
    } else {
      tr.push(
        `  %g = call ptr @scr_gen_of_fiber(ptr %self)`,
        ...emitter.pendingTestLines("%pend"),
        `  br i1 %pend, label %thrown, label %clean`,
        `clean:`,
      );
      switch (ret.kind) {
        case "void":
          tr.push(`  br label %done ; void body: the done value is undefined (NONE)`);
          break;
        case "f64":
          emitter.declare(`declare void @scr_gen_out_f64(ptr, double)`);
          tr.push(`  call void @scr_gen_out_f64(ptr %g, double %r)`, `  br label %done`);
          break;
        case "bool":
          emitter.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
          tr.push(`  call void @scr_gen_out_bool(ptr %g, i1 %r)`, `  br label %done`);
          break;
        default: {
          const v = vAdapters(emitter.shapeHost, ret);
          emitter.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
          tr.push(
            `  call void @scr_gen_out_ref(ptr %g, ptr %r, ptr ${v.release})`,
            `  br label %done`,
          );
        }
      }
      tr.push(
        `thrown:`,
        `  %genret = call zeroext i1 @scr_exc_genret_pending()`,
        `  br i1 %genret, label %promote, label %dropdummy`,
        `promote:`,
        `  call void @scr_exc_clear()`,
        `  call void @scr_gen_ret_to_out(ptr %g)`,
        `  br label %dropdummy`,
        `dropdummy:`,
      );
      if (ret.kind !== "void" && isRefCounted(ret)) {
        tr.push(
          `  call void ${releaseSym(emitter.shapeHost, ret)}(ptr %r) ; unwound: the never-read dummy`,
        );
      }
      tr.push(`  br label %done`, `done:`, `  ret void`, `}`, ``);
    }
    for (const line of tr) out.push(line);

    let settleAsync: string | null = null;
    if (fn.async) {
      emitter.declare(`declare ptr @scr_async_gen_new(ptr, ptr, ptr, ptr)`);
      const genT: IrType & { kind: "generator" } = {
        kind: "generator",
        async: true,
        yieldT: fn.generator.yieldT,
        retT: ret,
        nextT: fn.generator.nextT,
      };
      const resultT = fn.generator.resultType;
      const build = emitter.genResultThunkFor(genT, resultT);
      settleAsync = `${build}_async`;
      const settleKey = `ags:${typeKey(genT)}`;
      if (!emitter.resolveThunks.has(settleKey)) {
        emitter.resolveThunks.set(settleKey, settleAsync);
        const adapters = vAdapters(emitter.shapeHost, resultT);
        emitter.resolveThunkDefs.push(
          `define internal void @${settleAsync}(ptr %g, ptr %p) ${FN_ATTRS} {`,
          `entry:`,
          `  %r = call ptr @${build}(ptr %g)`,
          `  call void @scr_promise_fulfill_ref(ptr %p, ptr %r, ptr ${adapters.retain}, ptr ${adapters.release}, ptr ${traceArg(emitter.shapeHost, resultT)})`,
          `  ret void`,
          `}`,
          ``,
        );
      }
      emitter.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
    }

    // The never-started teardown: drop the packed (+1) arguments.
    const dr: string[] = [
      `define internal void @${mangleGenDrop(fn.name)}(ptr %ap) ${FN_ATTRS} {`,
      `entry:`,
    ];
    fieldTys.forEach((ty, i) => {
      const pType = lifted && i === 0 ? null : fn.params[lifted ? i - 1 : i]!.type;
      const refcounted = pType === null || isRefCounted(pType);
      if (!refcounted) return;
      dr.push(
        `  %dp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
        `  %dv${i} = load ptr, ptr %dp${i}`,
      );
      if (pType === null) {
        emitter.declare(`declare void @scr_closure_release(ptr)`);
        dr.push(`  call void @scr_closure_release(ptr %dv${i})`);
      } else {
        dr.push(`  call void ${releaseSym(emitter.shapeHost, pType)}(ptr %dv${i})`);
      }
    });
    dr.push(`  call void @free(ptr %ap)`, `  ret void`, `}`, ``);
    for (const line of dr) out.push(line);

    // An iterator helper's return() before its first next() closes the
    // source generator in its first argument slot.
    const closesSource = fn.generator.closesSource === true;
    if (fn.generator.tag !== undefined) emitter.declare(`declare void @scr_gen_set_tag(ptr, ptr)`);
    if (fn.generator.inheritsTag === true)
      emitter.declare(`declare void @scr_gen_copy_tag(ptr, ptr)`);
    if (closesSource) {
      const field = lifted ? 1 : 0;
      emitter.declare(`declare void @scr_gen_close(ptr)`);
      emitter.declare(`declare void @scr_gen_set_unstarted_return(ptr, ptr)`);
      out.push(
        `define internal void @${mangleGenSourceClose(fn.name)}(ptr %ap) ${FN_ATTRS} {`,
        `entry:`,
        `  %sp = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${field}`,
        `  %sv = load ptr, ptr %sp`,
        `  call void @scr_gen_close(ptr %sv)`,
        `  ret void`,
        `}`,
        ``,
      );
    }

    // Spawn wrapper: pack the args (+1 moves in), allocate the
    // SUSPENDED fiber — nothing runs until the first .next().
    if (lifted) {
      emitter.declare(`declare ptr @scr_closure_retain_v(ptr)`);
    }
    const sp: string[] = [
      `define internal ptr @${mangleGenSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; gen spawn ${fn.name}`,
      `entry:`,
      ...argPackLines,
    ];
    const genNew = coroBody && !emitter.wasi ? "scr_gen_new_stackless" : "scr_gen_new";
    if (genNew !== "scr_gen_new") emitter.declare(`declare ptr @${genNew}(ptr, ptr, ptr)`);
    const asyncGenNew =
      coroBody && !emitter.wasi ? "scr_async_gen_new_stackless" : "scr_async_gen_new";
    if (settleAsync !== null && asyncGenNew !== "scr_async_gen_new")
      emitter.declare(`declare ptr @${asyncGenNew}(ptr, ptr, ptr, ptr)`);
    sp.push(
      settleAsync === null
        ? `  %gg = call ptr @${genNew}(ptr @${mangleTrampoline(fn.name)}, ptr %ap, ptr @${mangleGenDrop(fn.name)})`
        : `  %gg = call ptr @${asyncGenNew}(ptr @${mangleTrampoline(fn.name)}, ptr %ap, ptr @${mangleGenDrop(fn.name)}, ptr @${settleAsync})`,
      ...(fn.generator.tag !== undefined
        ? [`  call void @scr_gen_set_tag(ptr %gg, ptr ${emitter.cstr(fn.generator.tag)})`]
        : []),
      ...(fn.generator.inheritsTag === true
        ? [`  call void @scr_gen_copy_tag(ptr %gg, ptr %a${lifted ? 1 : 0})`]
        : []),
      ...(closesSource
        ? [
            `  call void @scr_gen_set_unstarted_return(ptr %gg, ptr @${mangleGenSourceClose(fn.name)})`,
          ]
        : []),
      `  ret ptr %gg`,
      `}`,
      ``,
    );
    for (const line of sp) out.push(line);
  }
  return out;
}

/** Per-async-function machinery — async.ts's scaffolding, .ll
 * flavored: an argument-pack struct type, a fiber trampoline (unpacks,
 * frees the pack, runs the ordinary compiled body, settles the
 * promise — fulfilling on clean return, leaving a pending exception
 * for the runtime to reject with), and a spawn wrapper call sites and
 * closures enter through (packs the args +1, scr_async_spawn runs the
 * fiber eagerly to its first suspension and returns the promise). */
export function emitAsyncScaffolding(emitter: LlEmitter): string[] {
  const out: string[] = [];
  if (emitter.wasi) {
    emitter.declare(`declare void @llvm.coro.resume(ptr)`);
    emitter.declare(`declare void @llvm.coro.destroy(ptr)`);
    out.push(
      `define void @scr_wasi_coro_resume(ptr %handle) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @llvm.coro.resume(ptr %handle)`,
      `  ret void`,
      `}`,
      `define void @scr_wasi_coro_destroy(ptr %handle) ${FN_ATTRS} {`,
      `entry:`,
      `  call void @llvm.coro.destroy(ptr %handle)`,
      `  ret void`,
      `}`,
      ``,
    );
  }
  const fiberless = emitter.fiberlessAsyncFunctions();
  for (const fn of emitter.mod.functions) {
    if (fn.async !== true || fn.generator !== undefined) continue;
    if (fiberless.has(fn.name) && emitter.awaitCallees.has(fn.name)) {
      for (const line of emitter.emitAsyncAwaitCall(fn, null)) out.push(line);
    }
    if (fiberless.has(fn.name) && emitter.adoptCallees.has(fn.name)) {
      for (const line of emitter.emitAsyncAwaitCall(fn, null, true)) out.push(line);
    }
    if (emitter.inlineAwaitCallees.has(fn.name)) {
      for (const line of emitter.emitAsyncInlineAwaitCall(fn)) out.push(line);
    }
    if (fiberless.has(fn.name)) {
      const fieldTys = [
        ...(fn.captures !== undefined ? ["ptr"] : []),
        ...fn.params.map((p) => emitter.llType(p.type)),
      ];
      const params = fieldTys.map((ty, i) => `${ty} %a${i}`);
      for (const line of emitter.emitFiberlessAsyncSpawn(fn, params)) out.push(line);
      continue;
    }
    const { definitions, ret, tr, spawnParams, argPackLines } =
      emitter.emitArgPackAndTrampolinePrologue(fn);
    for (const line of definitions) out.push(line);
    if (emitter.awaitCallees.has(fn.name)) {
      for (const line of emitter.emitAsyncAwaitCall(fn, argPackLines)) out.push(line);
    }
    if (emitter.adoptCallees.has(fn.name)) {
      for (const line of emitter.emitAsyncAwaitCall(fn, argPackLines, true)) out.push(line);
    }
    const stackless = emitter.stacklessAsync.has(fn.name);
    if (stackless && emitter.directAwaitCallees.has(fn.name)) {
      // A coroutine's direct await: the same prefix, with the promise kept
      // inside the returned fiber record.
      emitter.declare(`declare ptr @scr_async_spawn_direct(ptr, ptr)`);
      out.push(
        `define internal ptr @${mangleAsyncDirectSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; direct spawn ${fn.name}`,
        `entry:`,
        ...argPackLines,
        `  %f = call ptr @scr_async_spawn_direct(ptr @${mangleTrampoline(fn.name)}, ptr %ap)`,
        `  ret ptr %f`,
        `}`,
        ``,
      );
    }
    const spawn = stackless ? "scr_async_spawn_stackless" : "scr_async_spawn";
    emitter.declare(`declare ptr @scr_fiber_promise(ptr)`);
    emitter.declare(`declare ptr @${spawn}(ptr, ptr)`);
    emitter.needOom();
    if (emitter.wasi || stackless) {
      // The coroutine body settles its own promise and owns the retained
      // lifted environment until final suspension. Its initial call
      // returns here at the first suspend (or final suspend).
      tr.push(`  ret void`, `}`, ``);
    } else {
      if (fn.captures !== undefined) {
        emitter.declare(`declare void @scr_closure_release(ptr)`);
      }
      tr.push(
        ...emitter.pendingTestLines("%pend"),
        `  br i1 %pend, label %thrown, label %clean`,
        `clean:`,
        `  %pr = call ptr @scr_fiber_promise(ptr %self)`,
      );
      for (const line of emitter.asyncFulfillLines(ret, "%pr")) tr.push(line);
      tr.push(`  ret void`, `thrown:`);
      if (ret.kind !== "void" && isRefCounted(ret)) {
        // An escaping throw means %r is the never-read dummy (NULL).
        tr.push(`  call void ${releaseSym(emitter.shapeHost, ret)}(ptr %r)`);
      }
      tr.push(`  ret void`, `}`, ``);
    }
    for (const line of tr) out.push(line);

    // Spawn wrapper: pack the args (+1 moves in), spawn the fiber.
    const cache = fn.asyncCacheGlobal !== undefined ? mangleGlobal(fn.asyncCacheGlobal) : null;
    const cycleCache =
      fn.asyncCycleCacheGlobal !== undefined ? mangleGlobal(fn.asyncCycleCacheGlobal) : null;
    if (cache !== null || cycleCache !== null) {
      emitter.declare(`declare ptr @scr_promise_retain_v(ptr)`);
      emitter.declare(`declare void @scr_promise_release(ptr)`);
    }
    if (cache !== null) {
      emitter.declare(`declare void @scr_promise_mark_handled(ptr)`);
    }
    if (fn.captures !== undefined) {
      emitter.declare(`declare ptr @scr_closure_retain_v(ptr)`);
    }
    const sp: string[] = [
      `define internal ptr @${mangleAsyncSpawn(fn.name)}(${spawnParams.join(", ")}) ${FN_ATTRS} { ; spawn ${fn.name}`,
      `entry:`,
      ...(cache !== null
        ? [
            `  %cached = load ptr, ptr @${cache}`,
            `  %cache_hit = icmp ne ptr %cached, null`,
            `  br i1 %cache_hit, label %cached_return, label %cache_miss`,
            `cached_return:`,
            `  %cached_owned = call ptr @scr_promise_retain_v(ptr %cached)`,
            `  ret ptr %cached_owned`,
            `cache_miss:`,
          ]
        : []),
      ...argPackLines,
    ];
    sp.push(
      `  %p = call ptr @${spawn}(ptr @${mangleTrampoline(fn.name)}, ptr %ap)`,
      ...(cache !== null
        ? [
            // The module loader owns this evaluation promise
            // immediately. A later sibling can throw before the
            // aggregate dependency wait is built, but this rejection
            // must never become an unrelated unhandled rejection.
            `  call void @scr_promise_mark_handled(ptr %p)`,
          ]
        : []),
      ...(cache !== null
        ? [
            `  %cache_owned = call ptr @scr_promise_retain_v(ptr %p)`,
            // The eager spawn may have re-entered this guarded module
            // through an admitted async cycle and installed a temporary
            // cache entry. Drop that owned slot before replacing it
            // with the outer evaluation promise.
            `  %replaced_cache = load ptr, ptr @${cache}`,
            `  call void @scr_promise_release(ptr %replaced_cache)`,
            `  store ptr %cache_owned, ptr @${cache}`,
          ]
        : []),
      ...(cycleCache !== null
        ? [
            // Eager recursive spawns publish from the inside out. The
            // runtime-requested outermost member writes last and is the
            // SCC's actual evaluation root.
            `  %cycle_cache_owned = call ptr @scr_promise_retain_v(ptr %p)`,
            `  %replaced_cycle_cache = load ptr, ptr @${cycleCache}`,
            `  call void @scr_promise_release(ptr %replaced_cycle_cache)`,
            `  store ptr %cycle_cache_owned, ptr @${cycleCache}`,
          ]
        : []),
      `  ret ptr %p`,
      `}`,
      ``,
    );
    for (const line of sp) out.push(line);
  }
  for (const line of emitter.emitGenScaffolding()) out.push(line);
  return out;
}

/** The await-call entry of an async function (`sc_aw_*`): one direct
 * `await f(...)` as a call returning the awaited value, so the call site
 * needs no promise of its own. A fiberless body runs on the caller's
 * stack as in its spawn wrapper; a clean result then takes the await's
 * one microtask turn (scr_await_hop) and is returned without ever
 * materializing the promise, which nothing else could observe. A throw
 * builds the rejected promise exactly as the spawn wrapper would and
 * awaits it, so the rejection reaches the awaiter on the same turn. Other
 * bodies pack their arguments as the spawn wrapper does and enter
 * scr_async_spawn_await_*, which parks the caller on the promise as soon
 * as the body first suspends. The adopting entry (`sc_ad_*`, for
 * `return f(...)` in an async function) adds the turn of the then job
 * that adopts the returned promise, before the await proper. */
export function emitAsyncAwaitCall(
  emitter: LlEmitter,
  fn: IrFunction,
  argPackLines: string[] | null,
  adopt: boolean,
): string[] {
  const ret = fn.returnType;
  const retTy = emitter.llType(ret);
  const params = fn.params.map((p, i) => `${emitter.llType(p.type)} %a${i}`);
  const awaitLine = (dest: string, promise: string): string => {
    switch (ret.kind) {
      case "void":
        emitter.declare(`declare void @scr_await_void(ptr)`);
        return `  call void @scr_await_void(ptr ${promise})`;
      case "f64":
        emitter.declare(`declare double @scr_await_f64(ptr)`);
        return `  ${dest} = call double @scr_await_f64(ptr ${promise})`;
      case "bool":
        emitter.declare(`declare zeroext i1 @scr_await_bool(ptr)`);
        return `  ${dest} = call zeroext i1 @scr_await_bool(ptr ${promise})`;
      case "string":
        emitter.declare(`declare ptr @scr_await_str(ptr)`);
        return `  ${dest} = call ptr @scr_await_str(ptr ${promise})`;
      default:
        emitter.declare(`declare ptr @scr_await_ref(ptr)`);
        return `  ${dest} = call ptr @scr_await_ref(ptr ${promise})`;
    }
  };
  const retLine = (v: string): string => (retTy === "void" ? `  ret void` : `  ret ${retTy} ${v}`);
  const head = adopt
    ? `define internal ${retTy} @${mangleAsyncAdoptCall(fn.name)}(${params.join(", ")}) ${FN_ATTRS} { ; adopt ${fn.name}`
    : `define internal ${retTy} @${mangleAsyncAwaitCall(fn.name)}(${params.join(", ")}) ${FN_ATTRS} { ; await ${fn.name}`;
  const args = params.join(", ");
  if (adopt && argPackLines !== null) {
    // A body that may suspend settles later than the adoption's then job
    // runs: materialize its promise, take that turn, then await it.
    emitter.declare(`declare void @scr_await_hop()`);
    emitter.declare(`declare void @scr_promise_release(ptr)`);
    return [
      head,
      `entry:`,
      `  %p = call ptr @${mangleAsyncSpawn(fn.name)}(${args})`,
      `  call void @scr_await_hop()`,
      awaitLine("%v", "%p"),
      `  call void @scr_promise_release(ptr %p)`,
      retLine("%v"),
      `}`,
      ``,
    ];
  }
  if (argPackLines !== null && emitter.stacklessAsync.has(fn.name)) {
    // A stackless body's eager prefix already runs on the awaiter's
    // stack, which then awaits the promise like the two separate steps.
    emitter.declare(`declare void @scr_promise_release(ptr)`);
    return [
      head,
      `entry:`,
      `  %p = call ptr @${mangleAsyncSpawn(fn.name)}(${args})`,
      awaitLine("%v", "%p"),
      `  call void @scr_promise_release(ptr %p)`,
      retLine("%v"),
      `}`,
      ``,
    ];
  }
  if (argPackLines !== null) {
    const kind =
      ret.kind === "void"
        ? "void"
        : ret.kind === "f64"
          ? "f64"
          : ret.kind === "bool"
            ? "bool"
            : ret.kind === "string"
              ? "str"
              : "ref";
    const cret = kind === "bool" ? "zeroext i1" : retTy;
    emitter.declare(`declare ${cret} @scr_async_spawn_await_${kind}(ptr, ptr)`);
    emitter.needOom();
    const call = `call ${cret} @scr_async_spawn_await_${kind}(ptr @${mangleTrampoline(fn.name)}, ptr %ap)`;
    return [
      head,
      `entry:`,
      ...argPackLines,
      kind === "void" ? `  ${call}` : `  %v = ${call}`,
      retLine("%v"),
      `}`,
      ``,
    ];
  }
  const framed = emitter.fiberlessFrames;
  if (framed) {
    emitter.declare(`declare void @scr_async_inline_enter(ptr)`);
    emitter.declare(`declare void @scr_async_inline_exit(ptr)`);
  }
  emitter.declare(`declare void @scr_await_hop()`);
  emitter.declare(`declare ptr @scr_promise_new()`);
  emitter.declare(`declare void @scr_promise_reject_pending(ptr)`);
  emitter.declare(`declare void @scr_promise_release(ptr)`);
  const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${args})`;
  const out = [
    head,
    `entry:`,
    ...(framed
      ? [`  %frame = alloca { ptr, ptr }`, `  call void @scr_async_inline_enter(ptr %frame)`]
      : []),
    retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`,
    ...emitter.pendingTestLines("%pend"),
    ...(framed ? [`  call void @scr_async_inline_exit(ptr %frame)`] : []),
    // Adopting: the then job's turn comes before the settled promise's
    // own reaction, whichever way the body completed.
    ...(adopt ? [`  call void @scr_await_hop()`] : []),
    `  br i1 %pend, label %thrown, label %clean`,
    `clean:`,
    `  call void @scr_await_hop()`,
    retLine("%r"),
    `thrown:`,
  ];
  if (ret.kind !== "void" && isRefCounted(ret)) {
    // An escaping throw means %r is the never-read dummy (NULL).
    out.push(`  call void ${releaseSym(emitter.shapeHost, ret)}(ptr %r)`);
  }
  out.push(
    `  %p = call ptr @scr_promise_new()`,
    `  call void @scr_promise_reject_pending(ptr %p)`,
    awaitLine("%v", "%p"),
    `  call void @scr_promise_release(ptr %p)`,
    retLine("%v"),
    `}`,
    ``,
  );
  return out;
}

/** Move a clean async return value into the current fiber's promise. */
export function emitWasiFulfill(emitter: LlEmitter, v: LlValue | null): void {
  const coro = emitter.currentCoro;
  if (coro === null)
    throw new InternalCompilerError("llvm emitter bug: wasm fulfillment outside async body");
  const ret = emitter.currentReturnType;
  if (coro.kind === "generator") {
    emitter.declare(`declare ptr @scr_gen_of_fiber(ptr)`);
    const gen = emitter.B.tmp();
    emitter.B.line(`${gen} = call ptr @scr_gen_of_fiber(ptr ${coro.self})`);
    switch (ret.kind) {
      case "void":
        return;
      case "f64":
        emitter.declare(`declare void @scr_gen_out_f64(ptr, double)`);
        emitter.B.line(`call void @scr_gen_out_f64(ptr ${gen}, double ${v!.name})`);
        return;
      case "bool":
        emitter.declare(`declare void @scr_gen_out_bool(ptr, i1 zeroext)`);
        emitter.B.line(`call void @scr_gen_out_bool(ptr ${gen}, i1 ${v!.name})`);
        return;
      default:
        emitter.declare(`declare void @scr_gen_out_ref(ptr, ptr, ptr)`);
        emitter.B.line(
          `call void @scr_gen_out_ref(ptr ${gen}, ptr ${v!.name}, ptr ${vAdapters(emitter.shapeHost, ret).release})`,
        );
        return;
    }
  }
  emitter.declare(`declare ptr @scr_fiber_promise(ptr)`);
  const pr = emitter.B.tmp();
  emitter.B.line(`${pr} = call ptr @scr_fiber_promise(ptr ${coro.self})`);
  switch (ret.kind) {
    case "void":
      emitter.declare(`declare void @scr_promise_fulfill_void(ptr)`);
      emitter.B.line(`call void @scr_promise_fulfill_void(ptr ${pr})`);
      break;
    case "f64":
      emitter.declare(`declare void @scr_promise_fulfill_f64(ptr, double)`);
      emitter.B.line(`call void @scr_promise_fulfill_f64(ptr ${pr}, double ${v!.name})`);
      break;
    case "bool":
      emitter.declare(`declare void @scr_promise_fulfill_bool(ptr, i1 zeroext)`);
      emitter.B.line(`call void @scr_promise_fulfill_bool(ptr ${pr}, i1 ${v!.name})`);
      break;
    case "string":
      emitter.declare(`declare void @scr_promise_fulfill_str(ptr, ptr)`);
      emitter.B.line(`call void @scr_promise_fulfill_str(ptr ${pr}, ptr ${v!.name}) ; moves in`);
      break;
    case "dyn":
      emitter.declare(`declare void @scr_promise_resolve_dyn(ptr, ptr)`);
      emitter.B.line(`call void @scr_promise_resolve_dyn(ptr ${pr}, ptr ${v!.name}) ; moves in`);
      break;
    default: {
      const rc = vAdapters(emitter.shapeHost, ret);
      emitter.declare(`declare void @scr_promise_fulfill_ref(ptr, ptr, ptr, ptr, ptr)`);
      emitter.B.line(
        `call void @scr_promise_fulfill_ref(ptr ${pr}, ptr ${v!.name}, ptr ${rc.retain}, ptr ${rc.release}, ptr ${traceArg(emitter.shapeHost, ret)})`,
      );
    }
  }
}

/** The argument-pack ABI and trampoline prefix shared by async functions
 * and generators. Their promise/generator completion and spawn tails stay
 * with the callers below. */
export function emitArgPackAndTrampolinePrologue(
  emitter: LlEmitter,
  fn: IrFunction,
): LlArgPackAndTrampolinePrologue {
  const pack = mangleArgPack(fn.name);
  const lifted = fn.captures !== undefined;
  const fieldTys = [...(lifted ? ["ptr"] : []), ...fn.params.map((p) => emitter.llType(p.type))];
  const definitions = [`%${pack} = type { ${fieldTys.join(", ") || "i8"} } ; ${fn.name} args`];
  const sizeOf = `ptrtoint (ptr getelementptr (%${pack}, ptr null, i32 1) to ${emitter.sizeType})`;

  // Async argument packs live from the spawn to the trampoline's first
  // instructions, so they take the runtime's small-block allocator.
  // Generator packs keep malloc: the runtime frees never-started ones.
  const smallPack = fn.generator === undefined;
  const packAlloc = smallPack ? "scr_rt_calloc" : "malloc";
  const packFree = smallPack ? "scr_rt_free" : "free";
  emitter.declare(`declare void @${packFree}(ptr)`);
  emitter.declare(`declare ptr @${packAlloc}(${emitter.sizeType})`);

  const tr: string[] = [
    `define internal void @${mangleTrampoline(fn.name)}(ptr %self, ptr %ap) ${FN_ATTRS} {`,
    `entry:`,
  ];
  const loads: string[] = [];
  fieldTys.forEach((ty, i) => {
    tr.push(
      `  %fp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
      `  %a${i} = load ${ty}, ptr %fp${i}`,
    );
    loads.push(`${ty} %a${i}`);
  });
  tr.push(`  call void @${packFree}(ptr %ap)`);
  const ret = fn.returnType;
  const retTy = emitter.llType(ret);
  const bodyCall = `call ${retTy} @${mangleFunction(fn.name)}(${loads.join(", ")})`;
  tr.push(retTy === "void" ? `  ${bodyCall}` : `  %r = ${bodyCall}`);
  if (lifted && !emitter.coroLowered(fn)) {
    tr.push(`  call void @scr_closure_release(ptr %a0)`);
  }

  const spawnParams = fieldTys.map((ty, i) => `${ty} %a${i}`);
  const argPackLines = [
    `  %ap = call ptr @${packAlloc}(${emitter.sizeType} ${sizeOf})`,
    `  %isnull = icmp eq ptr %ap, null`,
    `  br i1 %isnull, label %oom, label %ok`,
    `oom:`,
    `  call void @sc_oom()`,
    `  unreachable`,
    `ok:`,
  ];
  if (lifted) {
    // scr_closure_retain is a header static inline — the `_v` twin is
    // the exported symbol.
    argPackLines.push(`  %env = call ptr @scr_closure_retain_v(ptr %a0)`);
  }
  fieldTys.forEach((ty, i) => {
    const src = lifted && i === 0 ? "%env" : `%a${i}`;
    argPackLines.push(
      `  %sp${i} = getelementptr inbounds %${pack}, ptr %ap, i64 0, i32 ${i}`,
      `  store ${ty} ${src}, ptr %sp${i}`,
    );
  });
  return { definitions, pack, lifted, fieldTys, ret, tr, spawnParams, argPackLines };
}

/** The module functions whose bodies may park their execution context:
 * their emitted text mentions a suspension entry point (SUSPENDS), or
 * they mention such a function (transitively). Null where async bodies
 * must keep fibers regardless: wasm32 (its coroutine lowering owns async
 * bodies), worker programs, and programs that use node:test subtests,
 * whose `t.test()` awaits on the CURRENT fiber even from synchronous
 * code. */
export function parkingFunctions(emitter: LlEmitter): Set<string> | null {
  if (emitter.wasi || emitter.mod.workers === true) return null;
  const testSub = (text: string): boolean =>
    text.includes("@scr_test_sub") && /@scr_test_sub\b/.test(text);
  for (const decl of emitter.decls) if (testSub(decl)) return null;
  for (const text of emitter.fnDefText.values()) if (testSub(text)) return null;
  // Reverse mention edges, then propagate "may park" to every mentioner.
  const mentionedBy = new Map<string, Set<string>>();
  const parks = new Set<string>();
  const work: string[] = [];
  for (const [name, text] of emitter.fnDefText) {
    if (SUSPENDS.test(text)) {
      parks.add(name);
      work.push(name);
    }
    for (const callee of emitter.mentionedFunctions(text)) {
      if (callee === name) continue;
      let callers = mentionedBy.get(callee);
      if (callers === undefined) mentionedBy.set(callee, (callers = new Set()));
      callers.add(name);
    }
  }
  while (work.length > 0) {
    const callers = mentionedBy.get(work.pop()!);
    if (callers === undefined) continue;
    for (const caller of callers) {
      if (parks.has(caller)) continue;
      parks.add(caller);
      work.push(caller);
    }
  }
  return parks;
}

/** Async functions whose calls can skip the fiber (scr_async_inline_*).
 * A body qualifies only when nothing it runs can park its execution
 * context: its emitted text, and the text of every module function it
 * mentions (transitively), contains no suspension entry point. Such a
 * body always completes before the call returns, which is exactly the
 * behavior of a fiber that never suspends. Excluded conservatively:
 * wasm32 (its coroutine lowering owns async bodies), module-evaluation
 * bodies (their promise caches),
 * `dyn` results (resolution may adopt a thenable), and every program
 * that uses node:test subtests — `t.test()` runs a subtest inline and
 * awaits it on the CURRENT fiber even from synchronous code. Worker
 * programs keep fibers too: their fiber epilogue owns context
 * termination (a stopping worker rejects and observes the promise), which
 * the fiberless wrapper does not reproduce. A missed suspension still
 * cannot reorder execution undetected: the runtime traps when a context parks while a
 * fiberless body is on its stack. */
export function fiberlessAsyncFunctions(emitter: LlEmitter): Set<string> {
  const parks = emitter.parkingFunctions();
  const eligible = parks === null ? new Set<string>() : emitter.neverParkingAsync(parks);
  for (const name of emitter.inlineAwaitCallees)
    if (!eligible.has(name))
      throw new InternalCompilerError(`llvm emitter bug: inline await of suspending ${name}`);
  return eligible;
}
