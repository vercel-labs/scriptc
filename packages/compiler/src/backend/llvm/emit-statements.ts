/* LlEmitter's statement emission: the statement switch, try/catch, switch, loop copies, speculative writes and string self-concatenation. */
import {
  type LlEmitter,
  type LlScopeEntry,
  adoptingAwaitOf,
  MAX_BYTES_LOOP_VERSION_DEPTH,
} from "./emitter.js";
import { CAUGHT, F64, type IrExpr, type IrStmt, STRING, isRefCounted } from "../../ir/ir.js";
import { emitStringSliceSnapshot } from "./string-slices.js";
import {
  canDeferSplitPiece,
  emitSplitCursor,
  emitSplitNext,
  emitSplitScratch,
  emitSplitSnapshot,
  emitSplitSpanNext,
  loadSplitSnapshot,
  storeSplitSnapshot,
  stringSplit,
} from "./split-loops.js";
import {
  type StackObjectField,
  type StackObjectSource,
  emitStackObject,
  stackObjectFields,
  stackObjectStruct,
} from "./stack-objects.js";
import { emitStackUnion } from "./stack-unions.js";
import { emitBorrowedArrayRead, emitLocalArrayRead } from "./local-array-reads.js";
import { emitStackMapRead } from "./map-read-lifetimes.js";
import { allocateLocalUnion, storeLocalUnion } from "./local-union-storage.js";
import { boxAccess, boxNewCall, elemAccess } from "./shapes.js";
import { dynHoleRead } from "./loop-array-borrows.js";
import { endsWithJump, matchStringSelfConcat } from "../../ir/analysis.js";
import { charAtUnitRead, emitDiscardedSplice } from "./expr-containers.js";
import { InternalCompilerError } from "../../errors.js";
import {
  emitDenseArrayGet,
  emitDenseArrayPop,
  emitDenseArraySet,
  SCR_ELEM_I32,
} from "./dense-array-access.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";
import { f64Lit, llvmCommentText, loadArrCount, SCR_ARR_FIELD, sizeToDouble } from "./common.js";
import { planInt32KindLoop, type Int32KindLoopPlan } from "./int32-kind-loops.js";
import { withinInt32 } from "../../ir/integer-ranges.js";
import { resultSlotStore } from "../result-slots.js";
import {
  matchIntegerArrayForLoop,
  matchIntegerBytesForLoop,
  matchIntegerCountedForLoop,
  matchIntegerPairedForLoop,
} from "../../ir/integer-loops.js";
import { emitByteWindowGuard, matchByteWindow } from "./byte-windows.js";
import {
  countedDenseShape,
  emitDenseLoopGuard,
  matchDenseArrayLoop,
  pairedDenseShape,
} from "./dense-array-loops.js";
import {
  emitCountedLoopLimit,
  emitCountedLoopSafety,
  emitPairedLoopSafety,
} from "./counted-loops.js";
import { emitBytesLoopVersionGuard, type BytesLoopVersion } from "./bytes-loop-versions.js";
import { bytesHeaderAlias } from "./bytes-alias.js";
import { mangleLocal } from "../mangle.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import type { LlValue } from "./expr-context.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { widenInteger } from "./integer-values.js";
import { SCALAR_UNION_RESULT } from "./int32-abi.js";
import { emitLiteralSwitch } from "./switch-dispatch.js";
import {
  SPECULATIVE_RANGE,
  emitSafeIntegerCheck,
  emitSpeculativeInteger,
  planProvenIntegerLoop,
  planSpeculativeLoop,
  type ProvenLoopPlan,
  speculativeReads,
  speculativeWriteTarget,
} from "./speculative-integers.js";
import {
  emitConcatInputs,
  emitMixedConcat,
  numberPart,
  stringParts,
} from "./string-construction.js";
import { emitStringInputs } from "./string-lifetimes.js";
import { LOOPS } from "./loop-state.js";

/** A callback loop version copies the loop; keep the copies small. */
const MAX_CALLBACK_VERSION_COST = 400;

export function emitStmtBody(emitter: LlEmitter, s: IrStmt): void {
  const B = emitter.B;
  emitter.frames.push([]);
  switch (s.kind) {
    case "varDecl": {
      if (s.init && emitter.int32Locals.has(s.localId)) {
        emitter.storeInt32Local(s.localId, emitter.emitExpr(s.init), s.init);
        break;
      }
      const b = emitter.binding(s.localId);
      if (emitter.walkBorrows.has(s.localId) && b.kind === "local") {
        // A borrowed walk pointer: no retain now, no release at scope exit.
        const v = s.init === null ? "null" : emitter.emitReadReceiver(s.init).name;
        B.line(`store ptr ${v}, ptr ${b.slot}`);
        break;
      }
      const slice = emitter.scalarStringSlices.get(s.localId);
      if (slice) {
        const snapshot = emitStringSliceSnapshot(emitter, slice);
        emitter.stringSlices.set(s.localId, snapshot);
        emitter.scopes[emitter.scopes.length - 1]!.push({ slot: snapshot.source, type: STRING });
        break;
      }
      const split = emitter.privateSplitLocals.get(s.localId);
      if (split) {
        const snapshot = storeSplitSnapshot(emitter, emitSplitSnapshot(emitter, split));
        emitter.storedSplits.set(s.localId, snapshot);
        emitter.scopes[emitter.scopes.length - 1]!.push(
          { slot: snapshot.sourceSlot, type: STRING },
          { slot: snapshot.separatorSlot, type: STRING },
        );
        break;
      }
      const stackObject = emitter.localStackObjects.get(s.localId);
      if (stackObject) {
        const value = emitStackObject(emitter, stackObject, (fields) =>
          emitter.ownScopeFields(fields),
        );
        B.line(`store ptr ${value.name}, ptr ${b.slot}`);
        break;
      }
      if (s.init && emitter.reassignedStackObjects.has(s.localId)) {
        const slot = emitter.stackObjectSlot(s.localId, s.init.type);
        emitStackObject(
          emitter,
          s.init as StackObjectSource,
          (fields) => emitter.ownScopeFields(fields),
          slot,
        );
        B.line(`store ptr ${slot}, ptr ${b.slot}`);
        break;
      }
      const localUnion = emitter.localStackUnions.get(s.localId);
      if (localUnion) {
        const union = emitStackUnion(emitter, localUnion);
        B.line(`store ptr ${union.value.name}, ptr ${b.slot}`);
        if (union.payload) {
          emitter.toFrame(union.payload);
          emitter.scopes[emitter.scopes.length - 1]!.push({
            slot: union.payloadSlot,
            type: union.payload.type,
          });
        }
        break;
      }
      const localRead = emitter.localArrayReads.get(s.localId);
      if (localRead) {
        const owner = emitLocalArrayRead(
          emitter,
          !localRead.borrow && emitter.unwrittenLocalArrayRead(s, localRead)
            ? { ...localRead, borrow: true }
            : localRead,
          b.slot,
        );
        if (owner) emitter.scopes[emitter.scopes.length - 1]!.push(owner);
        break;
      }
      const mapRead = emitter.mapReadLifetimes.locals.get(s.localId);
      if (mapRead) {
        const result = emitStackMapRead(emitter, mapRead);
        B.line(`store ptr ${result.value.name}, ptr ${b.slot}`);
        if (result.owner) emitter.scopes[emitter.scopes.length - 1]!.push(result.owner);
        break;
      }
      const localStorage = emitter.localUnionStorageProofs.get(s.localId);
      if (localStorage && s.init) {
        const storage = allocateLocalUnion(emitter, localStorage);
        emitter.localUnionStorage.set(s.localId, storage);
        storeLocalUnion(emitter, storage, s.init);
        B.line(`store ptr ${storage.box}, ptr ${b.slot}`);
        if (storage.owner && storage.ownerType)
          emitter.scopes[emitter.scopes.length - 1]!.push({
            slot: storage.owner,
            type: storage.ownerType,
          });
        break;
      }
      if (b.kind === "boxed") {
        const stack = emitter.stackCaptures.emit(emitter, s.localId, b.type);
        if (stack) {
          B.line(`store ptr ${stack.box}, ptr ${b.slot}`);
          if (stack.owner) emitter.scopes[emitter.scopes.length - 1]!.push(stack.owner);
          if (s.init) {
            const value = emitter.emitExpr(s.init);
            if (isRefCounted(value.type)) emitter.toFrame(value);
            emitter.boxSet(stack.box, b.type, value.name);
          }
          break;
        }
        // Box FIRST, then evaluate the initializer: a named function
        // expression's closure captures this box during init evaluation.
        // A SCALAR TDZ box rides an ARR-kind box: the value lives in a
        // one-element array cell, so the empty (NULL) slot stays the
        // not-yet-initialized sentinel — a raw scalar slot has no spare
        // bit pattern to spend on it (stmts.ts's varDecl).
        const boxNew =
          b.local!.tdz === true && boxAccess(b.type) !== "ref"
            ? (emitter.declare(`declare ptr @scr_box_new(i32)`), `call ptr @scr_box_new(i32 3)`)
            : boxNewCall(emitter.shapeHost, b.type);
        const box = B.tmp();
        B.line(`${box} = ${boxNew} ; let ${b.local!.name} (boxed)`);
        B.line(`store ptr ${box}, ptr ${b.slot}`);
        emitter.scopes[emitter.scopes.length - 1]!.push({
          slot: b.slot,
          type: b.type,
          boxed: true,
        });
        if (s.init === null) {
          // An empty TDZ box whose payload can legitimately be NULL
          // starts at its distinct sentinel (tdzEmptySentinel).
          const sentinel = b.local!.tdz === true ? emitter.tdzEmptySentinel(b.type) : null;
          if (sentinel !== null) B.line(`store ptr ${sentinel}, ptr ${emitter.boxSlot(box)}`);
          break;
        }
        const v = emitter.emitExpr(s.init);
        if (isRefCounted(v.type)) emitter.toHeap(v); // the box takes ownership
        if (b.local!.tdz === true && boxAccess(b.type) !== "ref") {
          emitter.tdzScalarInit(box, b.type, v.name);
        } else {
          emitter.boxSet(box, b.type, v.name);
        }
        break;
      }
      if (s.init === null) {
        // Declared, uninitialized (`let x: number;`): reset the slot —
        // inside a loop the previous iteration's scope exit released the
        // old value and left a stale pointer (NULL-tolerant releases).
        if (isRefCounted(b.type)) {
          B.line(`store ptr null, ptr ${b.slot}`);
          emitter.scopes[emitter.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
        }
        break;
      }
      if (emitter.loopArrayBorrows.has(s) && s.init.kind === "arrayGet") {
        emitBorrowedArrayRead(emitter, s.init, b.slot);
        break;
      }
      const holeRead = emitter.loopArrayBorrows.has(s) ? dynHoleRead(s.init) : null;
      if (holeRead && s.init.kind === "ternary") {
        // A hole reads as the immortal undefined value, which needs no owner.
        const present = emitter.emitExpr(s.init.cond);
        const filled = B.newLabel("borrow.hole.filled"),
          missing = B.newLabel("borrow.hole.missing"),
          done = B.newLabel("borrow.hole.done");
        B.condBr(present.name, filled, missing);
        B.startBlock(filled);
        emitBorrowedArrayRead(emitter, holeRead, b.slot);
        B.br(done);
        B.startBlock(missing);
        emitter.declare("declare ptr @scr_dyn_undefined()");
        const undef = B.tmp();
        B.line(`${undef} = call ptr @scr_dyn_undefined()`);
        B.line(`store ptr ${undef}, ptr ${b.slot}`);
        B.br(done);
        B.startBlock(done);
        break;
      }
      // A stable lexical alias cannot outlive its unchanged local owner.
      // Whole-value uses still retain their own copies, so returning or
      // storing the alias preserves the ordinary heap representation.
      // Boxed captures, reassigned sources and projections need ownership.
      if (
        b.kind === "local" &&
        b.local &&
        isRefCounted(b.type) &&
        emitter.stableCallBindings.has(s.localId) &&
        (emitter.canBorrowCallArgument(s.init) || emitter.unwrittenAlias(s))
      ) {
        const v = emitter.emitReadReceiver(s.init);
        B.line(`store ptr ${v.name}, ptr ${b.slot}`);
        break;
      }
      const v = emitter.emitExpr(s.init);
      if (b.kind === "global") emitter.toHeap(v);
      else emitter.toFrame(v);
      B.line(`store ${emitter.llType(b.type)} ${v.name}, ptr ${b.slot}`);
      emitter.storeIntegerView(s.localId, v, s.init);
      storeIntegerTemp(emitter, s.localId, b, v);
      if (isRefCounted(b.type)) {
        emitter.scopes[emitter.scopes.length - 1]!.push({ slot: b.slot, type: b.type });
        emitter.noteLastUseMove(s, b);
      }
      break;
    }
    case "assign": {
      if (emitter.int32Locals.has(s.localId)) {
        emitter.storeInt32Local(s.localId, emitter.emitExpr(s.value), s.value);
        break;
      }
      const owner = emitter.reboundOwnerSlots.get(s.localId);
      if (owner !== undefined && !emitter.walkBorrows.has(s.localId)) {
        // A rebound borrowed parameter: the new value moves into the owner
        // slot, replacing (and releasing) the previous owned value. This
        // precedes the in-place string append, which would release the
        // caller's borrow.
        const param = emitter.binding(s.localId);
        const slot = param.slot;
        const v = emitter.emitExpr(s.value);
        emitter.toFrame(v);
        const old = B.tmp();
        B.line(`${old} = load ptr, ptr ${owner}`);
        emitter.releaseFrame(old, param.type);
        B.line(`store ptr ${v.name}, ptr ${slot}`);
        B.line(`store ptr ${v.name}, ptr ${owner}`);
        break;
      }
      if (emitter.reassignedStackObjects.has(s.localId)) {
        // The new value may read the old one: build it apart (its
        // reference fields owned by this statement until it completes),
        // then copy it over the binding's slot. The binding takes over the
        // new fields; the old ones are released after the slot no longer
        // holds them.
        const struct = stackObjectStruct(s.value.type);
        let owned: readonly StackObjectField[] = [];
        const value = emitStackObject(emitter, s.value as StackObjectSource, (fields) => {
          owned = fields;
          for (const field of fields) emitter.ownSlot(field.ptr, field.type);
        });
        const target = emitter.stackObjectSlot(s.localId, s.value.type);
        const old = stackObjectFields(emitter, s.value.type, target).map((field) => {
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${field.ptr}`);
          return { name: t, type: field.type };
        });
        const bits = B.tmp();
        B.line(`${bits} = load ${struct}, ptr ${value.name}`);
        B.line(`store ${struct} ${bits}, ptr ${target}`);
        emitter.disownSlots(owned);
        for (const field of old) emitter.releaseFrame(field.name, field.type);
        break;
      }
      const localStorage = emitter.localUnionStorage.get(s.localId);
      if (localStorage) {
        storeLocalUnion(emitter, localStorage, s.value);
        break;
      }
      const self = matchStringSelfConcat(s.localId, s.value);
      if (self) {
        emitter.emitStringSelfConcatAssign(s.localId, self.left, self.suffix, false);
        break;
      }
      const b = emitter.binding(s.localId);
      if (emitter.walkBorrows.has(s.localId) && b.kind === "local") {
        // Rebinding a borrowed walk pointer releases nothing.
        B.line(`store ptr ${emitter.emitReadReceiver(s.value).name}, ptr ${b.slot}`);
        break;
      }
      const v = emitter.emitExpr(s.value);
      if (b.kind === "global" && !s.initializes) emitter.checkGlobalTdz(s.localId);
      if (b.kind === "boxed") {
        emitter.writeBindingBox(emitter.loadBox(b.slot), b.local!, v.name, s.initializes);
        // The RHS remains frame-owned until a possible TDZ throw passes.
        if (isRefCounted(v.type)) emitter.toHeap(v);
        break;
      }
      if (b.kind === "global") emitter.toHeap(v);
      else emitter.toFrame(v);
      if (isRefCounted(b.type)) {
        const old = B.tmp();
        B.line(`${old} = load ptr, ptr ${b.slot}`);
        if (b.kind === "global") emitter.releaseHeap(old, b.type);
        else emitter.releaseFrame(old, b.type);
      }
      B.line(`store ${emitter.llType(b.type)} ${v.name}, ptr ${b.slot}`);
      emitter.storeIntegerView(s.localId, v, s.value);
      if (b.kind === "global" && emitter.immortalGlobals.has(s.localId)) {
        // An Immutable module constant (contracts/check.ts proved it is
        // fresh, publishable and never written): its graph becomes
        // immortal, so reads skip reference counting and the collector
        // never visits it.
        const lines = emitter.publishWalkers.emitPublish(v.name, v.type, s.loc);
        for (const line of lines) B.line(line.trimStart());
        // Reads of this global skip retains from here on, which is only
        // sound once the graph really is immortal. Node.js never fails
        // here, so a refusal means the contract proof was wrong: stop
        // rather than keep running with a mortal graph read as immortal.
        if (lines.length > 0) {
          emitter.declare(`declare zeroext i1 @scr_exc_pending()`);
          emitter.declare(`declare void @scr_trap(ptr)`);
          const refused = B.tmp();
          B.line(`${refused} = call zeroext i1 @scr_exc_pending()`);
          const stop = B.newLabel("immutable.refused");
          const done = B.newLabel("immutable.published");
          B.condBr(refused, stop, done);
          B.startBlock(stop);
          B.line(
            `call void @scr_trap(ptr ${emitter.cstr("scriptc: internal error: an Immutable value could not be published\n")})`,
          );
          B.terminate("unreachable");
          B.startBlock(done);
        }
      }
      break;
    }
    case "exprStmt":
      // A statement-position splice never observes its removed elements.
      if (!emitDiscardedSplice(emitter, s.expr)) emitter.emitDiscarded(s.expr);
      break;
    case "arraySet": {
      // Evaluation order matches JS: array, index, then value. Ownership
      // of a refcounted value moves into the array (the runtime releases
      // the replaced element itself). A local receiver that the index and
      // value cannot rebind is read in place, as for field stores; the
      // released element cannot reach that binding.
      if (emitter.emitArraySelfConcat(s)) break;
      const arr = emitter.emitStableReceiver(s.arr, [s.index, s.value]);
      const idx = emitter.emitExpr(s.index);
      const v = emitter.emitExpr(s.value);
      if (s.arr.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arraySet on non-array");
      if (emitter.checkedInt32Array(s.arr)) {
        // An int32 array with checked stores: the int32 arm stores an int32
        // value, and widens the array for any other first.
        emitter.emitPublishedArrayGuard(arr.name, s.arr.type, 0, idx.name);
        const elem = s.arr.type.elem;
        const proven = emitter.provenDenseIndex(s.arr, s.index);
        emitter.emitByElementKind(arr.name, null, (acc, widened) => {
          if (acc === "i32") emitter.emitCheckedInt32Store(arr.name, v.name, s.value, widened);
          emitDenseArraySet(emitter, arr.name, idx, s.index, acc, elem, v.name, proven);
          return null;
        });
        break;
      }
      const acc = emitter.arrayAccess(s.arr, s.arr.type.elem);
      const int32 = emitter.emitInt32KindStoreCheck(s.arr, v, s.value);
      emitter.emitPublishedArrayGuard(arr.name, s.arr.type, 0, idx.name);
      if (acc === "ref") emitter.toHeap(v);
      emitDenseArraySet(
        emitter,
        arr.name,
        idx,
        s.index,
        acc,
        s.arr.type.elem,
        v.name,
        emitter.provenDenseIndex(s.arr, s.index),
        int32,
      );
      break;
    }
    case "arraySetLength": {
      // Pop's `length = 0` store on an empty array only matters when the
      // array can be frozen (published); its operand is a local.
      if (
        s.pop === true &&
        s.length.kind === "numLit" &&
        s.length.value === 0 &&
        emitter.publishedTypes?.containerGuarded(s.arr.type) !== true
      )
        break;
      // The literal it follows was constructed with this capacity
      // (reservedArrayLength).
      if (emitter.consumedReserves.delete(s)) break;
      const arr = emitBorrowedInput(emitter, s.arr);
      const length = emitter.emitExpr(s.length);
      if (s.arr.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arraySetLength on non-array");
      if (s.reserve === true) {
        emitter.declare(`declare void @scr_arr_reserve_len(ptr, double)`);
        B.line(`call void @scr_arr_reserve_len(ptr ${arr.name}, double ${length.name})`);
        break;
      }
      emitter.emitPublishedArrayGuard(arr.name, s.arr.type, s.pop === true ? 2 : 3);
      emitter.declare(`declare void @scr_arr_set_len(ptr, double)`);
      // Assigning the current length (a reused work array reset to where
      // it already is) changes nothing: the runtime's validation accepts
      // exactly the value equal to the length (-0 included, NaN never),
      // and no element is released. Everything else keeps the call.
      const lenPtr = B.tmp(),
        len = B.tmp(),
        lenNumber = B.tmp(),
        same = B.tmp();
      const resize = B.newLabel("arr.len.set"),
        done = B.newLabel("arr.len.done");
      B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${arr.name}, i32 0, i32 1`);
      emitter.markMemoryPointer(lenPtr, "array:header");
      loadArrCount(emitter, len, lenPtr, emitter.fieldAliasAttachment(lenPtr));
      B.line(
        `${lenNumber} = ${sizeToDouble(emitter.sizeType)} ${emitter.sizeType} ${len} to double`,
      );
      B.line(`${same} = fcmp oeq double ${length.name}, ${lenNumber}`);
      B.condBr(same, done, resize);
      B.startBlock(resize);
      if (s.pop === true) {
        // A discarded pop's `length - 1` on a packed array removes the
        // last element inline, then releases it.
        const call = B.newLabel("arr.len.call"),
          pop = B.newLabel("arr.len.pop");
        const lastNumber = B.tmp(),
          dropsLast = B.tmp();
        B.line(`${lastNumber} = fsub double ${lenNumber}, 1.0`);
        B.line(`${dropsLast} = fcmp oeq double ${length.name}, ${lastNumber}`);
        B.condBr(dropsLast, pop, call);
        B.startBlock(pop);
        const elem = s.arr.type.elem;
        if (emitter.checkedInt32Array(s.arr)) {
          emitter.emitByElementKind(arr.name, null, (acc) => {
            emitDenseArrayPop(emitter, arr.name, acc, elem, call, call);
            return null;
          });
        } else {
          const acc = emitter.arrayAccess(s.arr, elem);
          const raw = emitDenseArrayPop(emitter, arr.name, acc, elem, call, call);
          if (acc === "ref" && isRefCounted(elem)) {
            const old = B.tmp();
            B.line(`${old} = inttoptr i64 ${raw} to ptr`);
            emitter.releaseHeap(old, elem);
          }
        }
        B.br(done);
        B.startBlock(call);
      }
      B.line(`call void @scr_arr_set_len(ptr ${arr.name}, double ${length.name})`);
      emitter.emitPendingCheck();
      B.br(done);
      B.startBlock(done);
      break;
    }
    case "arraySetUndefined":
    case "arrayDelete": {
      const arr = emitBorrowedInput(emitter, s.arr);
      const idx = emitter.emitExpr(s.index);
      if (s.arr.type.kind !== "array")
        throw new InternalCompilerError(`llvm emitter bug: ${s.kind} on non-array`);
      emitter.emitPublishedArrayGuard(
        arr.name,
        s.arr.type,
        s.kind === "arrayDelete" ? 5 : 0,
        idx.name,
      );
      const fn = s.kind === "arraySetUndefined" ? "scr_arr_set_undefined" : "scr_arr_delete";
      emitter.declare(
        `declare ${s.kind === "arrayDelete" ? "zeroext i1" : "void"} @${fn}(ptr, double)`,
      );
      if (s.kind === "arrayDelete")
        B.line(`call zeroext i1 @${fn}(ptr ${arr.name}, double ${idx.name})`);
      else B.line(`call void @${fn}(ptr ${arr.name}, double ${idx.name})`);
      break;
    }
    case "bytesSet": {
      // Typed-array element write: same evaluation order as arraySet;
      // the value is a scalar (the kind-specific inline path coerces
      // JS-exactly), so no ownership moves. Invalid writes are ignored.
      // IrBytesElem is static, so never rediscover it through the
      // generic runtime switch in a hot loop.
      const arr = emitter.emitStableReceiver(s.arr, [s.index, s.value]);
      const idx = emitter.emitExpr(s.index);
      const v = emitter.emitExpr(s.value);
      if (s.arr.type.kind !== "bytes")
        throw new InternalCompilerError("llvm emitter bug: bytesSet on non-bytes");
      emitter.emitBytesSet(
        s.arr.type.elem,
        arr.name,
        idx,
        v,
        s.index,
        s.value,
        emitter.bytesBounds.has(s),
        emitter.bytesOwned.has(s),
      );
      break;
    }
    case "fieldSet":
    case "recordSet": {
      // Evaluation order: obj, then value. New value moved in; the old
      // value is released AFTER the field is overwritten (unlink-then-
      // release — a release can trigger a cycle collection, which must
      // never see a heap edge whose count was already given up).
      // Classes and records share the struct layout, so one emission.
      const nullable =
        s.kind === "fieldSet" ? emitter.nullableFields.get(s.className, s.field) : null;
      if (nullable && s.kind === "fieldSet") {
        const obj = emitter.emitStableReceiver(s.obj, [s.value]);
        // (The guard precedes the value here: the nullable store
        // evaluates it itself.)
        emitter.emitStoreGuard(obj.name, s);
        emitter.emitNullableFieldStore(obj.name, s.className, s.field, nullable, s.value);
        break;
      }
      if (s.kind === "fieldSet" && emitter.int32Slots.isField(s.className, s.field)) {
        const obj = emitter.emitStableReceiver(s.obj, [s.value]);
        const v = emitter.emitExpr(s.value);
        emitter.emitStoreGuard(obj.name, s);
        const { ptr } = emitter.classFieldPtr(obj.name, s.className, s.field);
        emitter.storeInt32Field(ptr, v, s.value);
        break;
      }
      if (emitter.emitFieldSelfConcat(s)) break;
      const obj = emitter.emitStableReceiver(s.obj, [s.value]);
      const v = emitter.emitFieldValue(
        s.value,
        s.kind === "recordSet"
          ? emitter.recordFieldInline(s.shapeId, s.field)
          : emitter.inlineUnions.classField(s.className, s.field),
      );
      if (s.kind === "fieldSet") emitter.emitStoreGuard(obj.name, s);
      else if (emitter.publishedTypes?.recordGuarded(s.shapeId) === true)
        emitter.emitPublishedFieldGuard(obj.name, null, s.field);
      const { ptr, type, inline } =
        s.kind === "fieldSet"
          ? emitter.classFieldPtr(obj.name, s.className, s.field, "compressed")
          : emitter.recordFieldPtr(obj.name, s.shapeId, s.field);
      // A result-slot entry fills zeroed caller storage, each field once.
      if (resultSlotStore(emitter.currentFunctionName, s)) emitter.initField(ptr, type, inline, v);
      else emitter.replaceField(ptr, type, inline, v);
      if (
        s.kind === "fieldSet" &&
        s.field === "name" &&
        emitter.classMeta.get(s.className)?.root.def.name === "%Error"
      ) {
        const present = emitter.classFieldPtr(obj.name, s.className, "%namePresent").ptr;
        const enumerable = emitter.classFieldPtr(obj.name, s.className, "%nameEnumerable").ptr;
        const wasPresent = B.tmp(),
          wasEnumerable = B.tmp(),
          isPresent = B.tmp(),
          nextEnumerable = B.tmp();
        B.line(`${wasPresent} = load i8, ptr ${present}`);
        B.line(`${wasEnumerable} = load i8, ptr ${enumerable}`);
        B.line(`${isPresent} = icmp ne i8 ${wasPresent}, 0`);
        B.line(`${nextEnumerable} = select i1 ${isPresent}, i8 ${wasEnumerable}, i8 1`);
        B.line(`store i8 1, ptr ${present}`);
        B.line(`store i8 ${nextEnumerable}, ptr ${enumerable}`);
      }
      break;
    }
    case "recordKeyDelete": {
      // `delete obj[k]` on a pure index-signature shape: a Map delete on
      // the overflow (key and value released; absent keys no-op).
      const obj = emitter.emitExpr(s.obj);
      const key = emitter.emitExpr(s.key);
      if (emitter.publishedTypes?.recordGuarded(s.shapeId) === true) {
        // Node: "Cannot delete property 'k' of #<Object>" (key known at
        // run time only; the guard reports the frozen record generically).
        emitter.emitPublishedFieldGuard(obj.name, null, "[key]");
      }
      const ovf = emitter.recordOvfPtr(obj.name, s.shapeId);
      emitter.declare(`declare zeroext i1 @scr_map_delete_str(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_map_delete_str(ptr ${ovf}, ptr ${key.name})`);
      break;
    }
    case "recordKeySet": {
      // Dynamic-keyed record write (the C per-shape helper, inline):
      // declared keys write through (same-typed — dyn-valued shapes,
      // whose writes validate and can throw, stay refused), undeclared
      // keys insert/replace in the overflow map. Evaluation order: obj,
      // key, value; the write OWNS the value (+1 moves in).
      const obj = emitter.emitExpr(s.obj);
      const key = emitter.emitExpr(s.key);
      const v = emitter.emitExpr(s.value);
      if (emitter.publishedTypes?.recordGuarded(s.shapeId) === true)
        emitter.emitPublishedFieldGuard(obj.name, null, "[key]");
      if (isRefCounted(v.type)) emitter.toHeap(v);
      const shape = emitter.recordShape(s.shapeId);
      // Signature-free shapes dispatch over their (one-typed) declared
      // fields and TRAP on a miss (scr_record_key_miss — JS would add
      // the property, which a monomorphic struct cannot); overflow
      // shapes keep the map insert tail.
      const iv = shape.indexValue ?? shape.fields[0]?.type;
      if (!iv)
        throw new InternalCompilerError(
          `llvm emitter bug: keyed write on field-free non-overflow shape ${s.shapeId}`,
        );
      const vAcc = iv.kind === "f64" ? "f64" : iv.kind === "bool" ? "bool" : "ref";
      if (s.overflowOnly === true) {
        // A LITERAL key naming no declared field: a plain overflow
        // insert — no field chain.
        const ovf = emitter.recordOvfPtr(obj.name, s.shapeId);
        emitter.mapSet(ovf, "str", vAcc, key.name, v.name);
        break;
      }
      const join = B.newLabel("rks.j");
      if (iv.kind === "dyn" && shape.indexValue) {
        // A dyn-valued shape (the C recordKeySetHelper's dyn arm,
        // inline): declared keys VALIDATE the dyn value against the
        // field's type first (dynCheck — a mismatched write throws the
        // catchable TypeError and leaves the field untouched; JS would
        // store anything, the documented divergence); undeclared keys
        // insert the dyn value into the overflow map as-is.
        emitter.declare(`declare void @scr_dyn_release(ptr)`);
        for (const f of shape.fields) {
          const hit = B.tmp();
          B.line(
            `${hit} = call zeroext i1 ${emitter.literalEquals(f.name)}(ptr ${key.name}) ; ${llvmCommentText(f.name)}`,
          );
          const lh = B.newLabel("rks.h");
          const ln = B.newLabel("rks.n");
          B.condBr(hit, lh, ln);
          B.startBlock(lh);
          const pathSlot = B.slot();
          B.entryAllocas.push(`${pathSlot} = alloca %ScrDynPath`);
          const pp = B.tmp();
          const kp = B.tmp();
          const ip = B.tmp();
          B.line(`${pp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 0`);
          B.line(`store ptr null, ptr ${pp}`);
          B.line(`${kp} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 1`);
          B.line(`store ptr ${emitter.cstr(f.name)}, ptr ${kp}`);
          B.line(`${ip} = getelementptr inbounds %ScrDynPath, ptr ${pathSlot}, i64 0, i32 2`);
          B.line(`store ${emitter.sizeType} 0, ptr ${ip}`);
          const helper = emitter.dyn.dynCheckHelper(f.type);
          const fty = emitter.llType(f.type);
          const nv = B.tmp();
          B.line(
            `${nv} = call ${fty === "i1" ? "zeroext i1" : fty} @${helper}(ptr ${v.name}, ptr ${pathSlot})`,
          );
          B.line(`call void @scr_dyn_release(ptr ${v.name})`);
          // Mismatched write: TypeError pending, field untouched — the
          // statement-level check below unwinds.
          const pend = B.tmp();
          for (const line of emitter.pendingTestLines(pend)) B.line(line.trimStart());
          const lw = B.newLabel("rks.w");
          B.condBr(pend, join, lw);
          B.startBlock(lw);
          const { ptr, type, inline } = emitter.recordFieldPtr(obj.name, s.shapeId, f.name);
          if (inline) {
            // The slot copies the checked value's bits; nv is released below.
            emitter.storeField(ptr, type, nv, true);
            emitter.releaseFrame(nv, type);
          } else if (isRefCounted(type)) {
            const old = B.tmp();
            B.line(`${old} = load ptr, ptr ${ptr}`);
            emitter.storeField(ptr, type, nv, false);
            emitter.releaseHeap(old, type);
          } else {
            emitter.storeField(ptr, type, nv, false);
          }
          B.br(join);
          B.startBlock(ln);
        }
        const ovf = emitter.recordOvfPtr(obj.name, s.shapeId);
        emitter.mapSet(ovf, "str", vAcc, key.name, v.name);
        B.br(join);
        B.startBlock(join);
        // MAY THROW exactly when a dyn value can validate against a
        // declared field (stmts.ts's condition).
        if (shape.fields.length > 0) emitter.emitPendingCheck();
        break;
      }
      for (const f of shape.fields) {
        // typeEquals(f.type, iv) — the frontend fences everything else.
        const hit = B.tmp();
        B.line(
          `${hit} = call zeroext i1 ${emitter.literalEquals(f.name)}(ptr ${key.name}) ; ${llvmCommentText(f.name)}`,
        );
        const lh = B.newLabel("rks.h");
        const ln = B.newLabel("rks.n");
        B.condBr(hit, lh, ln);
        B.startBlock(lh);
        const { ptr, type, inline } = emitter.recordFieldPtr(obj.name, s.shapeId, f.name);
        if (inline) {
          // The write owns the moved-in value; the slot copies its bits.
          emitter.storeField(ptr, type, v.name, true);
          emitter.releaseHeap(v.name, type);
        } else if (isRefCounted(type)) {
          const old = B.tmp();
          B.line(`${old} = load ptr, ptr ${ptr}`);
          emitter.storeField(ptr, type, v.name, false);
          emitter.releaseHeap(old, type);
        } else {
          emitter.storeField(ptr, type, v.name, false);
        }
        B.br(join);
        B.startBlock(ln);
      }
      if (!shape.indexValue) {
        // The MISS on a fixed shape: release the moved-in value, throw
        // the catchable TypeError naming the key (scr_record_key_miss —
        // JS would add the property, the documented divergence).
        if (isRefCounted(iv)) emitter.releaseHeap(v.name, iv);
        emitter.declare(`declare void @scr_record_key_miss(ptr)`);
        B.line(`call void @scr_record_key_miss(ptr ${key.name})`);
        B.br(join);
        B.startBlock(join);
        emitter.emitPendingCheck();
        break;
      }
      const ovf = emitter.recordOvfPtr(obj.name, s.shapeId);
      emitter.mapSet(ovf, "str", vAcc, key.name, v.name);
      B.br(join);
      B.startBlock(join);
      break;
    }
    case "block": {
      if (s.labels === undefined) {
        emitter.emitBlock(s.body);
        break;
      }
      // A labeled block: `break lbl` inside branches to the end label.
      const le = B.newLabel("blk.e");
      emitter.jumpTargets.push({
        kind: "block",
        brkLabel: le,
        contLabel: null,
        labels: s.labels,
        frameDepth: emitter.frames.length,
        scopeDepth: emitter.scopes.length,
        finallyDepth: emitter.finallyStack.length,
      });
      emitter.emitBlock(s.body);
      emitter.jumpTargets.pop();
      B.br(le);
      B.startBlock(le);
      break;
    }
    case "if": {
      const cond = emitter.emitCondition(s.cond);
      const trueLabel = B.newLabel("if.t");
      const joinLabel = B.newLabel("if.j");
      const falseLabel = s.else_ ? B.newLabel("if.f") : joinLabel;
      // A running maximum or minimum is rarely updated; the weights keep
      // the branch, where a select would make each element wait on the last.
      const weights = emitter.runningExtrema.has(s)
        ? `, !prof !{!"branch_weights", i32 1, i32 1000}`
        : "";
      B.condBr(cond, trueLabel, falseLabel, weights);
      B.startBlock(trueLabel);
      emitter.emitBlock(s.then);
      B.br(joinLabel);
      if (s.else_) {
        B.startBlock(falseLabel);
        emitter.emitBlock(s.else_);
        B.br(joinLabel);
      }
      B.startBlock(joinLabel);
      break;
    }
    case "while": {
      const callbacks = callbackVersionBindings(emitter, s);
      if (callbacks) {
        emitCallbackVersionedLoop(emitter, s, callbacks);
        break;
      }
      const version =
        LOOPS.of(emitter).bytesLoopVersionsEnabled &&
        LOOPS.of(emitter).bytesLoopVersioning.size < MAX_BYTES_LOOP_VERSION_DEPTH &&
        !LOOPS.of(emitter).bytesLoopVersioning.has(s)
          ? emitter.matchBytesLoopVersion(s, null)
          : null;
      if (version) {
        emitVersionedLoop(emitter, s, version);
        break;
      }
      const workerBudget = emitter.workerLoopBudget(s);
      const le = B.newLabel("loop.e");
      emitter.emitLoopCopies(s, true, le, (exit) => {
        const lc = B.newLabel("loop.c");
        const lb = B.newLabel("loop.b");
        const lp = workerBudget !== null ? B.newLabel("loop.p") : lc;
        B.br(lc);
        B.startBlock(lc);
        enterLoopHeader(emitter, lc);
        B.condBr(emitter.emitCondition(s.cond), lb, exit);
        B.startBlock(lb);
        emitter.jumpTargets.push({
          kind: "loop",
          brkLabel: exit,
          contLabel: lp,
          labels: s.labels,
          frameDepth: emitter.frames.length,
          scopeDepth: emitter.scopes.length,
          finallyDepth: emitter.finallyStack.length,
        });
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        B.br(lp);
        if (lp !== lc) {
          B.startBlock(lp);
          emitter.emitWorkerLoopCheck(workerBudget);
          B.br(lc);
        }
      });
      B.startBlock(le);
      break;
    }
    case "doWhile": {
      const callbacks = callbackVersionBindings(emitter, s);
      if (callbacks) {
        emitCallbackVersionedLoop(emitter, s, callbacks);
        break;
      }
      const workerBudget = emitter.workerLoopBudget(s);
      // Body first (runs at least once); continue jumps to the CONDITION.
      const le = B.newLabel("loop.e");
      emitter.emitLoopCopies(s, true, le, (exit) => {
        const lb = B.newLabel("loop.b");
        const lc = B.newLabel("loop.c");
        B.br(lb);
        B.startBlock(lb);
        enterLoopHeader(emitter, lb);
        emitter.jumpTargets.push({
          kind: "loop",
          brkLabel: exit,
          contLabel: lc,
          labels: s.labels,
          frameDepth: emitter.frames.length,
          scopeDepth: emitter.scopes.length,
          finallyDepth: emitter.finallyStack.length,
        });
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        B.br(lc);
        B.startBlock(lc);
        emitter.emitWorkerLoopCheck(workerBudget);
        B.condBr(emitter.emitCondition(s.cond), lb, exit);
      });
      B.startBlock(le);
      break;
    }
    case "for": {
      const callbacks = callbackVersionBindings(emitter, s);
      if (callbacks) {
        emitCallbackVersionedLoop(emitter, s, callbacks);
        break;
      }
      // The init's scope wraps the whole loop (break/continue must NOT
      // release it — scopeDepth captured after the push, C parity).
      const integerArrayLoop =
        emitter.debug === null
          ? matchIntegerArrayForLoop(s, emitter.currentLocals, emitter.integerArrayBindings)
          : null;
      const integerLoop =
        integerArrayLoop ??
        (emitter.debug === null ? matchIntegerBytesForLoop(s, emitter.numericLocals) : null);
      const countedLoop =
        !integerLoop && LOOPS.of(emitter).countedLoopsEnabled
          ? matchIntegerCountedForLoop(
              s,
              emitter.numericLocals,
              emitter.integerRanges,
              LOOPS.of(emitter).unaliasedArrays,
            )
          : null;
      // Two counters closing in on each other (`lo++, hi--`) take the same
      // integer storage as a counted loop's one.
      const pairedLoop =
        !integerLoop && !countedLoop && LOOPS.of(emitter).countedLoopsEnabled
          ? matchIntegerPairedForLoop(s, emitter.numericLocals, emitter.integerRanges)
          : null;
      // Byte windows and dense loops reason about one counter.
      const window =
        countedLoop && countedLoop.followers.length === 0 && LOOPS.of(emitter).byteWindowsEnabled
          ? matchByteWindow(
              s,
              countedLoop,
              emitter.numericLocals,
              emitter.captureIds,
              emitter.integerRanges,
              LOOPS.of(emitter).byteWindowEntries.get(s) ?? new Set(),
            )
          : null;
      const denseShape = !LOOPS.of(emitter).denseLoopsEnabled
        ? null
        : integerArrayLoop
          ? {
              counter: integerArrayLoop.localId,
              length: integerArrayLoop.limitReceiver as IrExpr & { kind: "varRef" },
              range: { min: 0, max: 4294967294 },
            }
          : countedLoop && !countedLoop.guarded && countedLoop.followers.length === 0
            ? countedDenseShape(s, countedLoop)
            : pairedLoop
              ? pairedDenseShape(pairedLoop)
              : null;
      const dense =
        denseShape && !window
          ? matchDenseArrayLoop(
              s,
              denseShape,
              emitter.numericLocals,
              LOOPS.of(emitter).unaliasedArrays,
              LOOPS.of(emitter).denseLoopEntries.get(s) ?? new Set(),
            )
          : null;
      if (dense) {
        const valid = emitDenseLoopGuard(emitter, dense);
        const fast = B.newLabel("dense.loop.fast"),
          slow = B.newLabel("dense.loop.slow"),
          done = B.newLabel("dense.loop.done");
        B.condBr(valid, fast, slow);
        LOOPS.of(emitter).denseLoopsEnabled = false;
        try {
          B.startBlock(slow);
          emitter.emitStmt(s);
          B.br(done);
          B.startBlock(fast);
          LOOPS.of(emitter).denseLoop = dense;
          emitter.emitStmt(s);
          B.br(done);
        } finally {
          LOOPS.of(emitter).denseLoop = null;
          LOOPS.of(emitter).denseLoopsEnabled = true;
        }
        B.startBlock(done);
        break;
      }
      if (window) {
        const valid = emitByteWindowGuard(emitter, window);
        const fast = B.newLabel("bytes.window.fast"),
          slow = B.newLabel("bytes.window.slow"),
          done = B.newLabel("bytes.window.done");
        B.condBr(valid, fast, slow);
        const originalRanges = emitter.integerRanges,
          originalBounds = emitter.bytesBounds;
        LOOPS.of(emitter).byteWindowsEnabled = false;
        try {
          B.startBlock(slow);
          emitter.emitStmt(s);
          B.br(done);
          B.startBlock(fast);
          emitter.integerRanges = window.ranges;
          emitter.bytesBounds = new Set([...originalBounds, ...window.bounds]);
          emitter.emitStmt(s);
          B.br(done);
        } finally {
          emitter.integerRanges = originalRanges;
          emitter.bytesBounds = originalBounds;
          LOOPS.of(emitter).byteWindowsEnabled = true;
        }
        B.startBlock(done);
        break;
      }
      const versionable =
        LOOPS.of(emitter).bytesLoopVersionsEnabled &&
        LOOPS.of(emitter).bytesLoopVersioning.size < MAX_BYTES_LOOP_VERSION_DEPTH &&
        !LOOPS.of(emitter).bytesLoopVersioning.has(s);
      // A loop to a typed array's or an array's length keeps its integer
      // induction. Its counted form only gives the version guard the
      // counter's iteration space, so the guard also covers accesses of
      // other typed arrays at the counter, such as `x[i]` and `y[i]` in
      // `for (let i = 0; i < out.length; i++) out[i] = x[i] * y[i]`.
      const versionCounted =
        versionable && !countedLoop && integerLoop && LOOPS.of(emitter).countedLoopsEnabled
          ? matchIntegerCountedForLoop(
              s,
              emitter.numericLocals,
              emitter.integerRanges,
              LOOPS.of(emitter).unaliasedArrays,
            )
          : countedLoop;
      const version = versionable
        ? emitter.matchBytesLoopVersion(s, versionCounted, versionCounted ? null : pairedLoop)
        : null;
      if (version) {
        emitVersionedLoop(emitter, s, version);
        break;
      }
      let countedJoin: string | null = null;
      if (
        (countedLoop?.guarded || pairedLoop?.guarded) &&
        !LOOPS.of(emitter).provenCountedGuards.has(s)
      ) {
        const safe = countedLoop
          ? emitCountedLoopSafety(emitter, countedLoop)
          : emitPairedLoopSafety(emitter, pairedLoop!);
        const fast = B.newLabel("counted.fast");
        const slow = B.newLabel("counted.slow");
        countedJoin = B.newLabel("counted.done");
        B.condBr(safe, fast, slow);
        B.startBlock(slow);
        LOOPS.of(emitter).countedLoopsEnabled = false;
        emitter.emitStmt(s);
        LOOPS.of(emitter).countedLoopsEnabled = true;
        B.br(countedJoin);
        B.startBlock(fast);
      }
      emitter.scopes.push([]);
      let integerSlot: string | null = null;
      let countedLimit: string | null = null;
      const pairedSlots: string[] = [];
      const followerSlots: string[] = [];
      if (integerLoop) {
        integerSlot = B.slot();
        B.entryAllocas.push(
          `${integerSlot} = alloca ${emitter.sizeType} ; integer induction ${emitter.currentLocals.get(integerLoop.localId)!.name}`,
        );
        let start = "0";
        if (integerArrayLoop && s.init?.kind === "varDecl" && s.init.init) {
          const value = emitter.emitExpr(s.init.init);
          start = B.tmp();
          // The start is 0 or an enclosing array index plus one (at most
          // 2^32 - 1): on 64-bit targets the signed conversion is exact
          // and avoids x86-64's unsigned 64-bit conversion sequence.
          const conversion = emitter.sizeType === "i64" ? "fptosi" : "fptoui";
          B.line(`${start} = ${conversion} double ${value.name} to ${emitter.sizeType}`);
          emitter.integerArrayBindings.add(integerLoop.localId);
        }
        B.line(`store ${emitter.sizeType} ${start}, ptr ${integerSlot}`);
        emitter.integerLoopBindings.set(integerLoop.localId, {
          slot: integerSlot,
          type: emitter.sizeType,
          range:
            LOOPS.of(emitter).denseLoop?.counter === integerLoop.localId
              ? LOOPS.of(emitter).denseLoop!.range
              : { min: 0, max: integerArrayLoop ? 4294967294 : Number.MAX_SAFE_INTEGER - 1 },
        });
      } else if (countedLoop) {
        integerSlot = B.slot();
        B.entryAllocas.push(
          `${integerSlot} = alloca i64 ; integer induction ${emitter.currentLocals.get(countedLoop.localId)!.name}`,
        );
        const startNumber = emitter.emitExpr(countedLoop.start);
        const start = B.tmp();
        B.line(`${start} = fptosi double ${startNumber.name} to i64`);
        B.line(`store i64 ${start}, ptr ${integerSlot}`);
        emitter.integerLoopBindings.set(countedLoop.localId, {
          slot: integerSlot,
          type: "i64",
          signed: true,
          range:
            LOOPS.of(emitter).denseLoop?.counter === countedLoop.localId
              ? LOOPS.of(emitter).denseLoop!.range
              : countedLoop.range,
        });
        for (const follower of countedLoop.followers) {
          const slot = B.slot();
          B.entryAllocas.push(
            `${slot} = alloca i64 ; integer induction ${emitter.currentLocals.get(follower.localId)!.name}`,
          );
          const value = emitter.emitExpr(follower.start);
          const followerStart = B.tmp();
          B.line(`${followerStart} = fptosi double ${value.name} to i64`);
          B.line(`store i64 ${followerStart}, ptr ${slot}`);
          followerSlots.push(slot);
          emitter.integerLoopBindings.set(follower.localId, {
            slot,
            type: "i64",
            signed: true,
            range: follower.range,
          });
        }
        countedLimit = emitCountedLoopLimit(emitter, countedLoop);
      } else if (pairedLoop) {
        for (const counter of [pairedLoop.low, pairedLoop.high]) {
          const slot = B.slot();
          B.entryAllocas.push(
            `${slot} = alloca i64 ; integer induction ${emitter.currentLocals.get(counter.localId)!.name}`,
          );
          const value = emitter.emitExpr(counter.start);
          const start = B.tmp();
          B.line(`${start} = fptosi double ${value.name} to i64`);
          B.line(`store i64 ${start}, ptr ${slot}`);
          pairedSlots.push(slot);
          const dense = LOOPS.of(emitter).denseLoop;
          emitter.integerLoopBindings.set(counter.localId, {
            slot,
            type: "i64",
            signed: true,
            range:
              dense?.pair && dense.counter === pairedLoop.low.localId
                ? dense.range
                : pairedLoop.range,
          });
        }
      } else if (s.init) {
        // A multi-declarator head shares the loop's scope. Emitting its
        // IR block as an ordinary block would release captured/ref locals
        // before the first condition.
        const initializers = s.init.kind === "block" ? s.init.body : [s.init];
        for (const initializer of initializers) emitter.emitStmt(initializer);
      }
      const le = B.newLabel("loop.e");
      // JS `for (let i ...)`: each iteration gets a FRESH binding holding
      // a copy of the previous one (closures made in iteration k keep
      // seeing iteration k's value) — only observable, and only emitted,
      // when a let variable is captured (boxed). Freshen before the first
      // condition and again in the continue-target block before updating.
      const initializers = s.init?.kind === "block" ? s.init.body : s.init ? [s.init] : [];
      const capturedLets = initializers.flatMap((init) => {
        const local = init.kind === "varDecl" ? emitter.currentLocals.get(init.localId) : undefined;
        return local?.boxed && local.mutable ? [local] : [];
      });
      const freshenBindings = (): void => {
        for (const local of capturedLets) {
          const slot = `%${mangleLocal(local.id)}`;
          const fresh = B.tmp();
          const old = B.tmp();
          B.line(
            `${fresh} = ${boxNewCall(emitter.shapeHost, local.type)} ; per-iteration ${local.name}`,
          );
          B.line(`${old} = load ptr, ptr ${slot}`);
          const val = emitter.boxGet(old, local.type);
          emitter.boxSet(fresh, local.type, val);
          emitter.declare(`declare void @scr_box_release(ptr)`);
          B.line(`call void @scr_box_release(ptr ${old})`);
          B.line(`store ptr ${fresh}, ptr ${slot}`);
        }
      };
      const workerBudget = emitter.workerLoopBudget(s);
      freshenBindings();
      emitter.emitLoopCopies(s, capturedLets.length === 0, le, (exit) => {
        const lc = B.newLabel("loop.c");
        const lb = B.newLabel("loop.b");
        const lu =
          s.update || capturedLets.length > 0 || workerBudget !== null ? B.newLabel("loop.u") : lc;
        B.br(lc);
        B.startBlock(lc);
        enterLoopHeader(emitter, lc);
        if (integerLoop && integerSlot) {
          const receiver = emitter.emitStableReceiver(integerLoop.limitReceiver, []);
          const lenPtr = B.tmp();
          const len = B.tmp();
          const index = B.tmp();
          const inBounds = B.tmp();
          B.line(
            `${lenPtr} = getelementptr inbounds %${integerArrayLoop ? "ScrArr" : "ScrBytes"}, ptr ${receiver.name}, i64 0, i32 1`,
          );
          B.line(`${index} = load ${emitter.sizeType}, ptr ${integerSlot}`);
          if (integerArrayLoop) {
            // The counter starts at most 2^32 - 1 and steps only while it is
            // below the length, so it fits the i32 length field: compare in
            // 32 bits, which lets the compare read the field directly.
            emitter.markMemoryPointer(lenPtr, "array:header");
            B.line(`${len} = load i32, ptr ${lenPtr}${emitter.fieldAliasAttachment(lenPtr)}`);
            let narrow = index;
            if (emitter.sizeType === "i64") {
              narrow = B.tmp();
              B.line(`${narrow} = trunc i64 ${index} to i32`);
            }
            B.line(`${inBounds} = icmp ult i32 ${narrow}, ${len}`);
          } else {
            B.line(`${len} = load ${emitter.sizeType}, ptr ${lenPtr}${bytesHeaderAlias(emitter)}`);
            B.line(`${inBounds} = icmp ult ${emitter.sizeType} ${index}, ${len}`);
          }
          B.condBr(inBounds, lb, exit);
        } else if (countedLoop && integerSlot && countedLimit) {
          const index = B.tmp();
          const inBounds = B.tmp();
          B.line(`${index} = load i64, ptr ${integerSlot}`);
          B.line(
            `${inBounds} = icmp ${countedLoop.step > 0 ? "slt" : "sgt"} i64 ${index}, ${countedLimit}`,
          );
          B.condBr(inBounds, lb, exit);
        } else if (pairedLoop) {
          const low = B.tmp(),
            high = B.tmp(),
            open = B.tmp();
          B.line(`${low} = load i64, ptr ${pairedSlots[0]}`);
          B.line(`${high} = load i64, ptr ${pairedSlots[1]}`);
          B.line(`${open} = icmp ${pairedLoop.inclusive ? "sle" : "slt"} i64 ${low}, ${high}`);
          B.condBr(open, lb, exit);
        } else if (s.cond) B.condBr(emitter.emitCondition(s.cond), lb, exit);
        else B.br(lb);
        B.startBlock(lb);
        emitter.jumpTargets.push({
          kind: "loop",
          brkLabel: exit,
          contLabel: lu,
          labels: s.labels,
          frameDepth: emitter.frames.length,
          scopeDepth: emitter.scopes.length,
          finallyDepth: emitter.finallyStack.length,
        });
        emitter.emitBlock(s.body);
        emitter.jumpTargets.pop();
        B.br(lu);
        if (lu !== lc) {
          B.startBlock(lu);
          emitter.emitWorkerLoopCheck(workerBudget);
          freshenBindings();
          if (integerLoop && integerSlot) {
            const old = B.tmp();
            const next = B.tmp();
            B.line(`${old} = load ${emitter.sizeType}, ptr ${integerSlot}`);
            B.line(`${next} = add nuw ${emitter.sizeType} ${old}, 1`);
            B.line(`store ${emitter.sizeType} ${next}, ptr ${integerSlot}`);
          } else if (countedLoop && integerSlot) {
            const old = B.tmp();
            const next = B.tmp();
            B.line(`${old} = load i64, ptr ${integerSlot}`);
            B.line(`${next} = add nsw i64 ${old}, ${countedLoop.step}`);
            B.line(`store i64 ${next}, ptr ${integerSlot}`);
            countedLoop.followers.forEach((follower, i) => {
              const was = B.tmp();
              const now = B.tmp();
              B.line(`${was} = load i64, ptr ${followerSlots[i]}`);
              B.line(`${now} = add nsw i64 ${was}, ${follower.step}`);
              B.line(`store i64 ${now}, ptr ${followerSlots[i]}`);
            });
          } else if (pairedLoop) {
            [pairedLoop.low, pairedLoop.high].forEach((counter, i) => {
              const old = B.tmp();
              const next = B.tmp();
              B.line(`${old} = load i64, ptr ${pairedSlots[i]}`);
              B.line(`${next} = add nsw i64 ${old}, ${counter.step}`);
              B.line(`store i64 ${next}, ptr ${pairedSlots[i]}`);
            });
          } else if (s.update) emitter.emitStmt(s.update);
          B.br(lc);
        }
      });
      B.startBlock(le);
      emitter.releaseScope(emitter.scopes.pop()!);
      if (integerLoop) emitter.integerLoopBindings.delete(integerLoop.localId);
      if (countedLoop) {
        emitter.integerLoopBindings.delete(countedLoop.localId);
        for (const follower of countedLoop.followers)
          emitter.integerLoopBindings.delete(follower.localId);
      }
      if (pairedLoop) {
        emitter.integerLoopBindings.delete(pairedLoop.low.localId);
        emitter.integerLoopBindings.delete(pairedLoop.high.localId);
      }
      if (integerArrayLoop) emitter.integerArrayBindings.delete(integerArrayLoop.localId);
      if (countedJoin) {
        B.br(countedJoin);
        B.startBlock(countedJoin);
      }
      break;
    }
    case "forOf": {
      // Ascending index loop; the length is re-read every iteration
      // (JS-exact — pushes inside the body extend the iteration). The
      // iterable temp lives in this statement's frame, so it is released
      // when the whole loop ends (and by `return`'s frame sweep).
      if (s.iterable.type.kind !== "array")
        throw new LlvmUnsupportedError(`forOf:${s.iterable.type.kind}`, s.loc);
      const elem = s.iterable.type.elem;
      const stored =
        s.iterable.kind === "varRef" ? emitter.storedSplits.get(s.iterable.localId) : undefined;
      const direct = emitter.streamingSplitsEnabled ? stringSplit(s.iterable) : null;
      const snapshot = stored
        ? loadSplitSnapshot(emitter, stored)
        : direct
          ? emitSplitSnapshot(emitter, direct)
          : null;
      const arr = snapshot ? null : emitter.emitExpr(s.iterable);
      const cursor = snapshot ? emitSplitCursor(emitter, snapshot) : null;
      const scratch = snapshot ? emitSplitScratch(emitter) : null;
      const deferred = snapshot && canDeferSplitPiece(s, emitter.currentLocals.get(s.localId));
      const spanLength = deferred ? B.slot() : null;
      if (spanLength) B.entryAllocas.push(`${spanLength} = alloca ${emitter.sizeType}`);
      const idxSlot = snapshot ? null : B.slot();
      if (idxSlot) {
        B.entryAllocas.push(`${idxSlot} = alloca double`);
        B.line(`store double ${f64Lit(0)}, ptr ${idxSlot}`);
      }
      const lc = B.newLabel("fof.c");
      const lb = B.newLabel("fof.b");
      const lu = B.newLabel("fof.u");
      const le = B.newLabel("fof.e");
      const workerBudget = emitter.workerLoopBudget(s);
      B.br(lc);
      B.startBlock(lc);
      const inBounds = B.tmp();
      let cur: string;
      if (snapshot && cursor && scratch) {
        cur = spanLength
          ? emitSplitSpanNext(emitter, snapshot, cursor, spanLength)
          : emitSplitNext(emitter, snapshot, cursor, scratch);
        B.line(`${inBounds} = icmp ne ptr ${cur}, null`);
      } else {
        const i = B.tmp(),
          lenPtr = B.tmp(),
          rawLen = B.tmp(),
          len = B.tmp();
        B.line(`${i} = load double, ptr ${idxSlot}`);
        // The inline form of scr_arr_len, like the `length` intrinsic.
        B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${arr!.name}, i32 0, i32 1`);
        emitter.markMemoryPointer(lenPtr, "array:header");
        loadArrCount(emitter, rawLen, lenPtr, emitter.fieldAliasAttachment(lenPtr));
        B.line(
          `${len} = ${sizeToDouble(emitter.sizeType)} ${emitter.sizeType} ${rawLen} to double`,
        );
        B.line(`${inBounds} = fcmp olt double ${i}, ${len}`);
        cur = i;
      }
      B.condBr(inBounds, lb, le);
      B.startBlock(lb);
      emitter.jumpTargets.push({
        kind: "loop",
        brkLabel: le,
        contLabel: lu,
        labels: s.labels,
        frameDepth: emitter.frames.length,
        scopeDepth: emitter.scopes.length,
        finallyDepth: emitter.finallyStack.length,
      });
      // The loop variable is a fresh const per iteration: its scope opens
      // here, holds the (for ref elements: owned +1) current element, and
      // releases it at the end of each iteration.
      emitter.scopes.push([]);
      const localInfo = emitter.currentLocals.get(s.localId);
      const slot = `%${mangleLocal(s.localId)}`;
      const borrowedElement = !snapshot && emitter.loopArrayBorrows.has(s);
      if (!snapshot) {
        const acc = elemAccess(elem);
        const getter = borrowedElement ? "scr_arr_borrow_ref" : `scr_arr_get_${acc}`;
        cur = emitDenseArrayGet(
          emitter,
          arr!.name,
          { name: cur, type: { kind: "f64" } },
          undefined,
          acc,
          elem,
          getter,
          !borrowedElement,
        );
      }
      if (spanLength) {
        const length = B.tmp();
        B.line(`${length} = load ${emitter.sizeType}, ptr ${spanLength}`);
        emitter.splitSpans.set(s.localId, { bytes: cur, length, scratch: scratch! });
        cur = "null";
      }
      if (localInfo?.boxed) {
        // Captured loop variable: a fresh box per iteration, matching the
        // fresh const binding. The box takes ownership of a ref element's
        // +1 and is released with the iteration's scope.
        const box = B.tmp();
        B.line(`${box} = ${boxNewCall(emitter.shapeHost, elem)} ; per-iteration ${localInfo.name}`);
        emitter.boxSet(box, elem, cur);
        B.line(`store ptr ${box}, ptr ${slot}`);
        emitter.scopes[emitter.scopes.length - 1]!.push({ slot, type: elem, boxed: true });
      } else {
        B.line(`store ${emitter.llType(elem)} ${cur}, ptr ${slot}`);
        if (isRefCounted(elem) && !borrowedElement)
          emitter.scopes[emitter.scopes.length - 1]!.push({ slot, type: elem });
      }
      emitter.emitStmts(s.body);
      if (spanLength) emitter.splitSpans.delete(s.localId);
      const endedWithJump = endsWithJump(s.body);
      const scope = emitter.scopes.pop()!;
      if (!endedWithJump) emitter.releaseScope(scope);
      emitter.jumpTargets.pop();
      B.br(lu);
      B.startBlock(lu);
      emitter.emitWorkerLoopCheck(workerBudget);
      if (idxSlot) {
        const i2 = B.tmp(),
          i3 = B.tmp();
        B.line(`${i2} = load double, ptr ${idxSlot}`);
        B.line(`${i3} = fadd double ${i2}, ${f64Lit(1)}`);
        B.line(`store double ${i3}, ptr ${idxSlot}`);
      }
      B.br(lc);
      B.startBlock(le);
      break;
    }
    case "switch":
      emitter.emitSwitch(s);
      break;
    case "break": {
      // Unlabeled: the innermost loop OR switch (labeled blocks are
      // skipped); labeled: the entry carrying the label.
      let target: (typeof emitter.jumpTargets)[number] | undefined;
      for (let i = emitter.jumpTargets.length - 1; i >= 0; i--) {
        const t = emitter.jumpTargets[i]!;
        if (s.label !== undefined ? t.labels?.includes(s.label) : t.kind !== "block") {
          target = t;
          break;
        }
      }
      if (!target) throw new InternalCompilerError("llvm emitter bug: break target not found");
      emitter.emitFinallysForJump(target.finallyDepth, target.frameDepth, target.scopeDepth);
      if (!B.isTerminated()) B.terminate(`br label %${target.brkLabel}`);
      break;
    }
    case "continue": {
      // Unlabeled: the innermost loop; labeled: the loop carrying the
      // label (tsc + the validator guarantee it IS a loop).
      let target: (typeof emitter.jumpTargets)[number] | undefined;
      for (let i = emitter.jumpTargets.length - 1; i >= 0; i--) {
        const t = emitter.jumpTargets[i]!;
        if (t.kind === "loop" && (s.label === undefined || t.labels?.includes(s.label))) {
          target = t;
          break;
        }
      }
      if (!target || target.contLabel === null)
        throw new InternalCompilerError("llvm emitter bug: continue target not found");
      emitter.emitFinallysForJump(target.finallyDepth, target.frameDepth, target.scopeDepth);
      if (!B.isTerminated()) B.terminate(`br label %${target.contLabel}`);
      break;
    }
    case "return": {
      // The value computes FIRST (an SSA temp — finally mutations of
      // returned locals cannot change it, Node-exact), then every
      // crossed finally runs innermost-first with the frames/scopes/
      // tryStack it sees truncated to its region (its releases already
      // ran; a throw inside a copy propagates OUT of the completing
      // try, past its own catch), then the function-level releases and
      // the actual ret. The parked value owns a synthetic slot-backed
      // scope entry during each copy so a throwing finally releases it.
      const adopted =
        emitter.finallyStack.length > 0 || emitter.tryStack.length > 0
          ? adoptingAwaitOf(s.value)
          : null;
      if (adopted !== null) {
        emitter.emitAdoptingReturn(s, adopted);
        break;
      }
      let v: LlValue | null = null;
      const moved =
        emitter.finallyStack.length === 0 && !emitter.currentUnionResult
          ? emitter.movableReturn(s.value)
          : null;
      if (s.value !== null && emitter.currentUnionResult) {
        // The tag and payload bits leave in registers; a heap box the
        // value needed is released with its frame below.
        const box = emitter.emitUnionProjection(s.value);
        v = { name: emitter.scalarUnionPair(box.name, s.value.type), type: s.value.type };
      } else if (moved !== null) {
        // Returning an owned local hands its reference to the caller: no
        // retain now and no release of the local below.
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${moved.entry.slot}`);
        v = { name: t, type: s.value!.type };
        moved.scope.splice(moved.scope.indexOf(moved.entry), 1);
        emitter.releaseForJump(0, 0);
        moved.scope.splice(moved.index, 0, moved.entry);
      } else if (s.value !== null && emitter.currentBorrowedReturn) {
        // A borrowed-return body hands back its walk without a reference
        // (it has no try statements, so no finally can intervene). An
        // optional element read lends the element its array keeps alive.
        const read = emitter.optionalArrayReads.get(s.value);
        if (read) {
          const slot = B.slot();
          B.entryAllocas.push(`${slot} = alloca ptr`);
          emitLocalArrayRead(emitter, { ...read, borrow: true }, slot);
          const t = B.tmp();
          B.line(`${t} = load ptr, ptr ${slot}`);
          v = { name: t, type: s.value.type };
        } else v = emitter.emitReadReceiver(s.value);
      } else if (s.value !== null) {
        v = emitter.emitExpr(s.value);
        if (emitter.currentCoro !== null) emitter.toHeap(v);
        else emitter.toFrame(v);
      }
      // An async generator's `return v` awaits v before any crossed
      // finally runs. Past finally regions that turn is taken here and
      // the request settles at completion; otherwise the completion's
      // own turn is the await (nothing runs in between).
      const genSettles =
        emitter.currentAsyncGenerator && (s.awaited === true || emitter.finallyStack.length > 0);
      // A completion turn that awaits x replaces a return() request's
      // already-taken await.
      if (emitter.currentAsyncGenerator && !genSettles) {
        emitter.declare(`declare void @scr_async_gen_return_awaits()`);
        B.line(`call void @scr_async_gen_return_awaits()`);
      }
      if (emitter.currentAsyncGenerator && s.awaited !== true && emitter.finallyStack.length > 0) {
        if (emitter.wasi) emitter.emitWasiSuspend(null);
        else {
          emitter.declare(`declare void @scr_await_hop()`);
          B.line(`call void @scr_await_hop()`);
        }
      }
      if (emitter.finallyStack.length > 0) {
        let pretSlot: string | null = null;
        if (v !== null && isRefCounted(v.type) && !emitter.currentUnionResult) {
          pretSlot = B.slot();
          B.entryAllocas.push(`${pretSlot} = alloca ptr ; pending return (through finally)`);
          B.line(`store ptr ${v.name}, ptr ${pretSlot}`);
        }
        const savedFrames = emitter.frames;
        const savedScopes = emitter.scopes;
        const savedFinally = emitter.finallyStack;
        const savedTry = emitter.tryStack;
        for (let i = savedFinally.length - 1; i >= 0 && !B.isTerminated(); i--) {
          const fin = savedFinally[i]!;
          emitter.releaseForJump(fin.frameDepth, fin.scopeDepth);
          emitter.frames = emitter.frames.slice(0, fin.frameDepth);
          emitter.scopes = emitter.scopes.slice(0, fin.scopeDepth);
          emitter.finallyStack = savedFinally.slice(0, i);
          emitter.tryStack = savedTry.slice(0, fin.tryDepth);
          if (pretSlot !== null) emitter.scopes.push([{ slot: pretSlot, type: v!.type }]);
          emitter.emitBlock(fin.body);
          if (pretSlot !== null) emitter.scopes.pop();
        }
        if (!B.isTerminated()) emitter.releaseForJump(0, 0);
        emitter.frames = savedFrames;
        emitter.scopes = savedScopes;
        emitter.finallyStack = savedFinally;
        emitter.tryStack = savedTry;
      } else if (moved === null) {
        emitter.releaseForJump(0, 0);
      }
      if (!B.isTerminated()) {
        if (genSettles) emitter.emitAsyncGenSettled();
        if (emitter.currentCoro !== null) {
          emitter.emitWasiFulfill(v);
          B.terminate(`br label %${emitter.currentCoro.finalLabel}`);
        } else if (v === null) B.terminate("ret void");
        else if (emitter.currentInt32Result)
          B.terminate(`ret i32 ${emitter.int32Argument(v, s.value!)}`);
        else if (emitter.currentUnionResult) B.terminate(`ret ${SCALAR_UNION_RESULT} ${v.name}`);
        else B.terminate(`ret ${emitter.llType(s.value!.type)} ${v.name}`);
      }
      break;
    }
    case "throw": {
      // Evaluate, move ownership into the runtime's exception cell, then
      // unwind unconditionally (the innermost try handler, or out of the
      // function) — the same release path as return/break/continue.
      const v = emitter.emitExpr(s.value);
      if (isRefCounted(s.value.type)) emitter.toHeap(v); // the cell takes ownership
      emitter.emitThrowValue({ name: v.name, type: s.value.type });
      emitter.emitUnwind();
      break;
    }
    case "rethrow": {
      // Re-raise the saved snapshot (payload retained — the binding
      // local releases with its scope) and unwind like `throw`.
      const c = emitter.emitExpr({ kind: "varRef", localId: s.localId, type: CAUGHT, loc: s.loc });
      emitter.declare(`declare void @scr_rethrow(ptr)`);
      B.line(`call void @scr_rethrow(ptr ${c.name})`);
      emitter.emitUnwind();
      break;
    }
    case "runtimeFence": {
      // The deferred JS compile fence: throw a catchable Error naming
      // the construct (message) with the SC code stamped on `code`,
      // then unwind exactly like `throw`. SCR_ERR_ERROR = 0.
      const bytes = Buffer.byteLength(s.message, "utf8");
      emitter.declare(`declare void @scr_throw_error_msg_code(i32, ptr, ${emitter.sizeType}, ptr)`);
      B.line(
        `call void @scr_throw_error_msg_code(i32 0, ptr ${emitter.cstr(s.message)}, ${emitter.sizeType} ${bytes}, ptr ${emitter.cstr(s.code)})`,
      );
      emitter.emitUnwind();
      break;
    }
    case "tryCatch":
      emitter.emitTryCatch(s);
      break;
    default: {
      // Statement coverage is now total (bytesSet closed the set) —
      // keep throwing LlvmUnsupportedError for any future IR statement kind.
      const rest: never = s;
      const k = (rest as IrStmt).kind;
      throw new LlvmUnsupportedError(`stmt:${k}`, (rest as IrStmt).loc);
    }
  }
  const frame = emitter.frames.pop()!;
  // return/throw already released their frames on the jump path; the
  // fall-through releases after them would be dead double-release code.
  if (
    s.kind !== "return" &&
    s.kind !== "throw" &&
    s.kind !== "rethrow" &&
    s.kind !== "runtimeFence"
  ) {
    emitter.releaseTemps(frame);
  }
}

/** try/catch/finally via pending-flag unwinding — stmts.ts's
 * emitTryCatch, block-flavored. Entering a try emits NO code: the try
 * context is compile-time state (tryStack) redirecting unwinds inside
 * the region to a label here. Shape:
 *
 *   { try body }           unwinds inside release frames/scopes down to
 *                          this statement's depths, then br the handler
 *   br after               (normal completion skips the handler)
 *   try.c:                 (emitted only when some unwind targets it)
 *     binding = scr_exc_take()   (or scr_exc_clear() when bindingless)
 *     { catch body }
 *   after: { finally body }      normal path
 *   br try.e
 *   try.fx:                exception path: the pending exception is
 *     stash = scr_exc_take()     STASHED across the finally body so the
 *     { finally body }           body's own pending checks answer for
 *     scr_rethrow(stash)         themselves; a throw inside REPLACES the
 *     <unwind>                   stash (it unwinds through the synthetic
 *   try.e:                       scope entry) — JS's semantics exactly
 *
 * Abrupt completions inside tryBody/catchBody ride the finallyStack:
 * returns inline copies at the return site, while break/continue use the
 * shared region walk before branching to their resolved target. */
/** A constant number local whose initializer has an exact integer form
 * (such as `const j = i * 4` in a typed-array loop version) keeps that
 * integer in an i64 slot beside the double, so reads such as `px[j + 1]`
 * index with integer arithmetic instead of converting the double back.
 * Every other declaration of the local drops the integer: the same
 * declaration is emitted once per loop copy, and a copy must not read the
 * integer another copy stored. */
function storeIntegerTemp(
  emitter: LlEmitter,
  localId: string,
  b: ReturnType<LlEmitter["binding"]>,
  v: LlValue,
): void {
  const local = b.local;
  if (
    !emitter.integerTempsEnabled ||
    b.kind !== "local" ||
    !local ||
    local.type.kind !== "f64" ||
    local.mutable ||
    local.tdz === true ||
    emitter.captureIds.has(localId) ||
    !v.integer
  ) {
    emitter.integerTemps.delete(localId);
    return;
  }
  const B = emitter.B;
  let slot = emitter.integerTemps.get(localId)?.slot;
  if (slot === undefined) {
    slot = B.slot();
    B.entryAllocas.push(`${slot} = alloca i64 ; integer ${local.name}`);
  }
  B.line(`store i64 ${widenInteger(emitter, v.integer)}, ptr ${slot}`);
  emitter.integerTemps.set(localId, {
    slot,
    type: "i64",
    signed: true,
    range: v.integer.range,
  });
}

export function emitTryCatch(emitter: LlEmitter, s: IrStmt & { kind: "tryCatch" }): void {
  const B = emitter.B;
  const hasCatch = s.catchBody !== null;
  const hasFinally = s.finallyBody !== null;
  const catchLabel = B.newLabel("try.c");
  const finExcLabel = B.newLabel("try.fx");
  const endLabel = B.newLabel("try.e");
  const afterTryLabel = hasFinally ? B.newLabel("try.f") : endLabel;

  const handler = {
    label: hasCatch ? catchLabel : finExcLabel,
    used: false,
    frameDepth: emitter.frames.length,
    scopeDepth: emitter.scopes.length,
  };
  if (hasFinally) {
    emitter.finallyStack.push({
      frameDepth: emitter.frames.length,
      scopeDepth: emitter.scopes.length,
      tryDepth: emitter.tryStack.length,
      body: s.finallyBody!,
    });
  }
  emitter.tryStack.push(handler);
  emitter.emitBlock(s.tryBody);
  emitter.tryStack.pop();
  B.br(afterTryLabel); // no-op when the try body already terminated

  // Exceptions raised in the CATCH body unwind to the exception-path
  // finally (pending stays set through it) when one exists.
  const excHandler = {
    label: finExcLabel,
    used: !hasCatch && handler.used,
    frameDepth: emitter.frames.length,
    scopeDepth: emitter.scopes.length,
  };

  if (hasCatch && handler.used) {
    B.startBlock(catchLabel);
    if (hasFinally) emitter.tryStack.push(excHandler);
    if (emitter.currentGenerator !== null) {
      // Generator bodies: a pending GENRET sentinel (.return(v)
      // injected at a yield) is a RETURN completion, not a throw —
      // catch must not take it. Re-unwind past this handler (finally
      // still runs — the unwind targets the exception-path finally or
      // the enclosing context; the depths here equal the handler's).
      emitter.declare(`declare zeroext i1 @scr_exc_genret_pending()`);
      const gr = B.tmp();
      B.line(`${gr} = call zeroext i1 @scr_exc_genret_pending()`);
      const lg = B.newLabel("try.gr");
      const lk = B.newLabel("try.gk");
      B.condBr(gr, lg, lk);
      B.startBlock(lg);
      emitter.emitUnwind();
      B.startBlock(lk);
    }
    if (s.catchLocalId !== null) {
      // catch (e): the exception MOVES into the binding's snapshot box,
      // owned by the catch body's scope (released on every exit —
      // normal fall-through, jumps out, and unwinds from the body).
      const slot = `%${mangleLocal(s.catchLocalId)}`;
      emitter.declare(`declare ptr @scr_exc_take()`);
      emitter.emitBlock(s.catchBody!, (scope) => {
        const c = B.tmp();
        B.line(`${c} = call ptr @scr_exc_take() ; catch binding`);
        if (emitter.currentLocals.get(s.catchLocalId!)?.boxed) {
          const box = B.tmp();
          B.line(`${box} = ${boxNewCall(emitter.shapeHost, CAUGHT)} ; captured exception`);
          emitter.boxSet(box, CAUGHT, c);
          B.line(`store ptr ${box}, ptr ${slot}`);
          scope.push({ slot, type: CAUGHT, boxed: true });
        } else {
          B.line(`store ptr ${c}, ptr ${slot}`);
          scope.push({ slot, type: CAUGHT });
        }
      });
    } else {
      emitter.declare(`declare void @scr_exc_clear()`);
      B.line(`call void @scr_exc_clear() ; catch takes the exception`);
      emitter.emitBlock(s.catchBody!);
    }
    if (hasFinally) emitter.tryStack.pop();
    B.br(afterTryLabel); // the catch's normal completion
  }
  if (hasFinally) emitter.finallyStack.pop();

  if (hasFinally) {
    B.startBlock(afterTryLabel);
    emitter.emitBlock(s.finallyBody!); // normal path
    B.br(endLabel);
    if (excHandler.used) {
      // The pending exception is STASHED across the finally body (a
      // ScrCaught snapshot, re-raised after) so the body runs with a
      // CLEAN cell — see stmts.ts's exception-path copy. The
      // stash rides an alloca slot so a throw inside the body unwinds
      // through the synthetic scope entry (replace semantics).
      B.startBlock(finExcLabel);
      emitter.declare(`declare ptr @scr_exc_take()`);
      emitter.declare(`declare void @scr_rethrow(ptr)`);
      emitter.declare(`declare void @scr_caught_release(ptr)`);
      const stash = B.tmp();
      const stashSlot = B.slot();
      B.entryAllocas.push(`${stashSlot} = alloca ptr ; finally exception stash`);
      B.line(`${stash} = call ptr @scr_exc_take() ; stash across finally`);
      B.line(`store ptr ${stash}, ptr ${stashSlot}`);
      emitter.scopes.push([{ slot: stashSlot, type: CAUGHT }]);
      const suppressHandler =
        s.suppressFinallyErrors || s.dropFinallyErrors
          ? {
              label: B.newLabel("try.fs"),
              used: false,
              frameDepth: emitter.frames.length,
              scopeDepth: emitter.scopes.length,
            }
          : null;
      if (suppressHandler) emitter.tryStack.push(suppressHandler);
      emitter.emitBlock(s.finallyBody!);
      if (suppressHandler) emitter.tryStack.pop();
      emitter.scopes.pop(); // normal completion keeps the stash for the re-raise
      B.line(`call void @scr_rethrow(ptr ${stash})`);
      B.line(`call void @scr_caught_release(ptr ${stash})`);
      emitter.emitUnwind();
      if (suppressHandler?.used) {
        B.startBlock(suppressHandler.label);
        const cleanup = s.dropFinallyErrors ? "scr_exc_keep_first" : "scr_exc_suppress";
        emitter.declare(`declare void @${cleanup}(ptr)`);
        B.line(`call void @${cleanup}(ptr ${stash}) ; consumes stash`);
        emitter.emitUnwind();
      }
    }
    B.startBlock(endLabel);
  } else {
    B.startBlock(endLabel);
  }
}

/** JS-exact switch: lazily evaluated, arbitrary-expression case tests in
 * source order, bodies falling through in source order until a break —
 * Literal-only tests can use native dispatch; other tests keep a chain
 * of conditional branches. All case bodies
 * share ONE scope; because dispatch can jump PAST a varDecl into a later
 * case, refcounted/boxed case-body locals are NULL-reset up front and
 * the scope-exit releases rely on NULL tolerance. */
export function emitSwitch(emitter: LlEmitter, s: IrStmt & { kind: "switch" }): void {
  const unitSwitch = charAtUnitSwitch(emitter, s);
  if (unitSwitch !== null) return emitSwitch(emitter, unitSwitch);
  const B = emitter.B;
  const discKind = s.disc.type.kind;
  if (discKind !== "f64" && discKind !== "string" && discKind !== "bool") {
    throw new LlvmUnsupportedError(`switch:${discKind}`, s.loc);
  }
  // The disc temp lives in the whole statement's frame: for a string
  // discriminant it stays alive across every test and body, released
  // when the switch statement ends (break lands past this statement's
  // frame release — releaseForJump keeps the target's own frame).
  const disc = emitter.emitExpr(s.disc);
  for (const c of s.cases) {
    for (const stmt of c.body) {
      if (stmt.kind !== "varDecl") continue;
      const local = emitter.currentLocals.get(stmt.localId)!;
      if (local.boxed || isRefCounted(local.type)) {
        B.line(`store ptr null, ptr %${mangleLocal(local.id)} ; case-scoped ${local.name}`);
      }
    }
  }
  const end = B.newLabel("sw.e");
  const caseLabels = s.cases.map(() => B.newLabel("sw.c"));
  const defaultIdx = s.cases.findIndex((c) => c.test === null);
  const fallback = defaultIdx >= 0 ? caseLabels[defaultIdx]! : end;
  const nullableString = nullableStringSwitch(emitter, s);
  if (nullableString !== null) {
    // `undefined` matches no string literal; any other value is the
    // string itself and dispatches as a string switch.
    const value = emitter.emitExpr(nullableString.value);
    const present = B.tmp();
    const dispatch = B.newLabel("sw.string");
    B.line(`${present} = icmp ne ptr ${value.name}, null`);
    B.condBr(present, dispatch, fallback);
    B.startBlock(dispatch);
    const text: LlValue = { name: value.name, type: STRING };
    if (!emitLiteralSwitch(emitter, text, undefined, nullableString.cases, caseLabels, fallback)) {
      nullableString.cases.forEach((c, i) => {
        if (c.test?.kind !== "strLit") return;
        const hit = B.tmp();
        B.line(
          `${hit} = call zeroext i1 ${emitter.literalEquals(c.test.value)}(ptr ${value.name})`,
        );
        const next = B.newLabel("sw.t");
        B.condBr(hit, caseLabels[i]!, next);
        B.startBlock(next);
      });
      B.br(fallback);
    }
  } else if (!emitLiteralSwitch(emitter, disc, s.disc, s.cases, caseLabels, fallback)) {
    s.cases.forEach((c, i) => {
      if (c.test === null) return;
      // Lazy source-order test evaluation (a test after the match never
      // runs). Each test's temps release right after its comparison.
      emitter.frames.push([]);
      const t = emitter.emitExpr(c.test);
      const hit = B.tmp();
      if (c.test.kind === "strLit") {
        B.line(`${hit} = call zeroext i1 ${emitter.literalEquals(c.test.value)}(ptr ${disc.name})`);
      } else if (c.test.type.kind === "string") {
        emitter.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        B.line(`${hit} = call zeroext i1 @sc_str_eq(ptr ${disc.name}, ptr ${t.name})`);
      } else if (c.test.type.kind === "bool") {
        B.line(`${hit} = icmp eq i1 ${disc.name}, ${t.name}`);
      } else {
        B.line(`${hit} = fcmp oeq double ${disc.name}, ${t.name}`);
      }
      emitter.releaseTemps(emitter.frames.pop()!);
      const next = B.newLabel("sw.t");
      B.condBr(hit, caseLabels[i]!, next);
      B.startBlock(next);
    });
    B.br(fallback);
  }

  emitter.jumpTargets.push({
    kind: "switch",
    brkLabel: end,
    contLabel: null,
    labels: s.labels,
    frameDepth: emitter.frames.length,
    scopeDepth: emitter.scopes.length,
    finallyDepth: emitter.finallyStack.length,
  });
  const scope: LlScopeEntry[] = [];
  emitter.scopes.push(scope);
  s.cases.forEach((c, i) => {
    B.br(caseLabels[i]!); // the previous body's natural fall-through
    B.startBlock(caseLabels[i]!);
    emitter.emitStmts(c.body);
  });
  emitter.jumpTargets.pop();
  emitter.scopes.pop();
  // Natural fall-off of the last body releases the shared scope; a jump
  // already released it before jumping.
  const lastBody = s.cases[s.cases.length - 1]?.body;
  if (!lastBody || !endsWithJump(lastBody)) emitter.releaseScope(scope);
  B.br(end);
  B.startBlock(end);
}

/** The loop copies a callback loop version needs: the bindings the loop
 * calls that the constant-callback census resolves to one function, each
 * with that function's direct entry. Only small loops of optimized
 * synchronous functions, and only bindings declared before the loop,
 * qualify: the guard reads each binding before the loop runs. Versions do
 * not nest: a loop inside either copy of a version (including the
 * versioned loop itself, emitted again for each copy) keeps its calls as
 * they are, so a loop nest is emitted at most twice. */
function callbackVersionBindings(
  emitter: LlEmitter,
  s: IrStmt & { kind: "for" | "while" | "doWhile" },
): { ref: IrExpr & { kind: "varRef" }; direct: string }[] | null {
  if (
    !emitter.callbackVersionsEnabled ||
    emitter.currentConstantCallbacks.size === 0 ||
    emitter.callbackVersioning.size > 0
  )
    return null;
  const found = new Map<string, { ref: IrExpr & { kind: "varRef" }; direct: string }>();
  // Bindings the loop declares or writes (a callback declared in its body).
  const bound = new Set<string>();
  let cost = 0;
  const expr = (e: IrExpr): boolean => {
    if (++cost > MAX_CALLBACK_VERSION_COST) return false;
    if (e.kind === "assignExpr") bound.add(e.localId);
    if (e.kind === "callValue" && e.callee.kind === "varRef" && !found.has(e.callee.localId)) {
      const local = emitter.currentLocals.get(e.callee.localId);
      const target =
        local && local.tdz !== true ? emitter.knownCallbackTarget(e.callee) : undefined;
      if (target) found.set(e.callee.localId, { ref: e.callee, direct: target.direct });
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (x: IrStmt): boolean => {
    if (++cost > MAX_CALLBACK_VERSION_COST) return false;
    if (x.kind === "varDecl" || x.kind === "assign" || x.kind === "forOf") bound.add(x.localId);
    else if (x.kind === "tryCatch" && x.catchLocalId !== null) bound.add(x.catchLocalId);
    return everyStmtChild(x, expr, stmt);
  };
  if (!stmt(s)) return null;
  const bindings = [...found.values()].filter(({ ref }) => !bound.has(ref.localId));
  return bindings.length > 0 ? bindings : null;
}

/** A callback loop version. The guard tests, once before the loop, that
 * each binding's closure holds its known function: a closure's code
 * pointer is written only when the closure is built, and the census
 * resolves only bindings the function never rebinds. The copy where the
 * guard holds calls those functions directly, with no indirect fallback
 * that could rewrite the closure or what it captures, so LLVM can keep a
 * captured scalar the callback updates in a register. The other copy is the
 * ordinary loop. */
function emitCallbackVersionedLoop(
  emitter: LlEmitter,
  s: IrStmt & { kind: "for" | "while" | "doWhile" },
  bindings: { ref: IrExpr & { kind: "varRef" }; direct: string }[],
): void {
  const B = emitter.B;
  let ok = "true";
  for (const { ref, direct } of bindings) {
    // A borrowed read: the guard only compares the code pointer.
    const closure = emitter.emitReadReceiver(ref).name;
    const fnp = B.tmp(),
      fn = B.tmp(),
      same = B.tmp();
    B.line(`${fnp} = getelementptr inbounds %ScrClosure, ptr ${closure}, i64 0, i32 1`);
    B.line(`${fn} = load ptr, ptr ${fnp}`);
    B.line(`${same} = icmp eq ptr ${fn}, ${direct}`);
    if (ok === "true") ok = same;
    else {
      const both = B.tmp();
      B.line(`${both} = and i1 ${ok}, ${same}`);
      ok = both;
    }
  }
  const fast = B.newLabel("callback.version.fast"),
    slow = B.newLabel("callback.version.slow"),
    done = B.newLabel("callback.version.done");
  B.condBr(ok, fast, slow);
  emitter.callbackVersioning.add(s);
  try {
    B.startBlock(slow);
    emitter.emitStmt(s);
    B.br(done);
    B.startBlock(fast);
    for (const { ref } of bindings) emitter.knownCallbacks.add(ref.localId);
    emitter.emitStmt(s);
    B.br(done);
  } finally {
    for (const { ref } of bindings) emitter.knownCallbacks.delete(ref.localId);
    emitter.callbackVersioning.delete(s);
  }
  B.startBlock(done);
}

/** Entries in a row whose fast copy bailed before a speculative loop site
 * stops trying it. */
const SPECULATION_BAILS = 8;

/** Emit a loop's condition, body and update through `emitCopy`, twice
 * when speculative-integers.ts plans a fast integer copy. Both copies
 * share the loop's setup and exit; the ordinary copy comes first so the
 * fast copy is only emitted when every resume point exists. */
/** A typed-array loop version: the guard, then the checked copy, which
 * runs whenever the guard fails, and the copy whose accesses the guard
 * proves in bounds (or thread-owned). */
function emitVersionedLoop(
  emitter: LlEmitter,
  s: IrStmt & { kind: "for" | "while" },
  version: BytesLoopVersion,
): void {
  const B = emitter.B;
  const fast = B.newLabel("bytes.version.fast"),
    slow = B.newLabel("bytes.version.slow"),
    done = B.newLabel("bytes.version.done");
  emitBytesLoopVersionGuard(emitter, version, fast, slow);
  const originalBounds = emitter.bytesBounds,
    originalOwned = emitter.bytesOwned,
    originalRanges = emitter.integerRanges;
  LOOPS.of(emitter).bytesLoopVersioning.add(s);
  try {
    B.startBlock(slow);
    emitter.emitStmt(s);
    B.br(done);
    B.startBlock(fast);
    emitter.bytesBounds = new Set([...originalBounds, ...version.bounds]);
    if (version.owned.size > 0) emitter.bytesOwned = new Set([...originalOwned, ...version.owned]);
    if (version.ranges.size > 0)
      emitter.integerRanges = new Map([...originalRanges, ...version.ranges]);
    if (version.counted?.guarded || version.paired?.loop.guarded)
      LOOPS.of(emitter).provenCountedGuards.add(s);
    emitter.emitStmt(s);
    B.br(done);
  } finally {
    emitter.bytesBounds = originalBounds;
    emitter.bytesOwned = originalOwned;
    emitter.integerRanges = originalRanges;
    LOOPS.of(emitter).provenCountedGuards.delete(s);
    LOOPS.of(emitter).bytesLoopVersioning.delete(s);
  }
  B.startBlock(done);
}

export function emitLoopCopies(
  emitter: LlEmitter,
  loop: Extract<IrStmt, { kind: "while" | "doWhile" | "for" }>,
  allowed: boolean,
  exit: string,
  emitCopy: (exit: string) => void,
): void {
  const plan =
    allowed &&
    emitter.speculativeLoopsEnabled &&
    emitter.speculation === null &&
    emitter.speculationResume === null
      ? planSpeculativeLoop(
          loop,
          (id) => emitter.speculativeLocal(id),
          (id) => emitter.integerLoopBindings.has(id) || emitter.int32Locals.has(id),
          (e) => {
            const range = emitter.integerRanges.get(e);
            return (
              range !== undefined &&
              range !== null &&
              range.min >= -Number.MAX_SAFE_INTEGER &&
              range.max <= Number.MAX_SAFE_INTEGER
            );
          },
          (id) => emitter.speculativeLocal(id) || emitter.speculativeInvariantGlobal(id),
        )
      : null;
  if (!plan) {
    const ordinary = (exit: string): void => {
      const proven = allowed ? planProvenLoop(emitter, loop) : null;
      if (proven) emitProvenLoop(emitter, proven, exit, emitCopy);
      else emitCopy(exit);
    };
    const kinds =
      allowed &&
      emitter.speculativeLoopsEnabled &&
      emitter.int32Slots.checkedInt32Arrays.size > 0 &&
      emitter.int32Kinds === null &&
      emitter.speculation === null &&
      emitter.speculationResume === null
        ? planInt32KindLoop(
            loop,
            (id) => emitter.checkedInt32Local(id),
            (e) => withinInt32(emitter.integerRanges.get(e)),
          )
        : null;
    if (kinds) emitInt32KindLoop(emitter, kinds, exit, kinds.writes.size > 0 ? emitCopy : ordinary);
    else ordinary(exit);
    return;
  }
  const B = emitter.B;
  const entries = new Map<string, string>();
  let ok = "true";
  for (const [id, live] of plan.locals) {
    if (!live) continue;
    const value = B.tmp();
    B.line(`${value} = load double, ptr ${emitter.binding(id).slot}`);
    const [integer, exact] = emitSafeIntegerCheck(emitter, value);
    entries.set(id, integer);
    if (ok === "true") ok = exact;
    else {
      const both = B.tmp();
      B.line(`${both} = and i1 ${ok}, ${exact}`);
      ok = both;
    }
  }
  // Each entry whose fast copy bails counts at the loop site, and a fast
  // copy that completes a speculated write and leaves the loop clears the
  // count. After SPECULATION_BAILS bailing entries in a row, the site runs
  // the ordinary copy only. The count is a hint: both copies give the same
  // results, and a race between workers loses at most an update.
  const bails = emitter.speculativeLoopSite();
  const count = B.tmp(),
    trying = B.tmp();
  B.line(`${count} = load atomic i8, ptr ${bails} unordered, align 1`);
  B.line(`${trying} = icmp ult i8 ${count}, ${SPECULATION_BAILS}`);
  if (ok === "true") ok = trying;
  else {
    const both = B.tmp();
    B.line(`${both} = and i1 ${ok}, ${trying}`);
    ok = both;
  }
  const fast = B.newLabel("spec.fast"),
    slow = B.newLabel("spec.slow");
  B.condBr(ok, fast, slow);
  const resume = new Map<IrStmt, { label: string; placed: boolean }>();
  for (const s of plan.writes) resume.set(s, { label: B.newLabel("spec.resume"), placed: false });
  // A failed check finishes its iteration in a third copy, entered only
  // there: it re-executes the statement and the rest of the body and the
  // update, then enters the ordinary copy through its header. Jumping
  // into the middle of the ordinary copy instead would give that loop a
  // second entry, and LLVM does not optimize an irreducible loop.
  const points = [...resume.values()];
  let header: string | null = null;
  B.startBlock(slow);
  emitter.speculationHeader = (label) => {
    header = label;
  };
  try {
    emitCopy(exit);
  } finally {
    emitter.speculationHeader = null;
  }
  if (header === null)
    throw new InternalCompilerError("llvm emitter bug: speculative loop copy without a header");
  B.startBlock(B.newLabel("spec.tail"));
  emitter.speculationResume = resume;
  emitter.speculationHeader = () => {
    B.br(header!);
    B.startBlock(B.newLabel("spec.unused"));
  };
  try {
    emitCopy(exit);
  } finally {
    emitter.speculationResume = null;
    emitter.speculationHeader = null;
  }
  B.startBlock(fast);
  if (!points.every((r) => r.placed)) {
    B.br(slow);
    return;
  }
  const ran = B.slot();
  B.entryAllocas.push(`${ran} = alloca i1 ; speculated write completed`);
  B.line(`store i1 false, ptr ${ran}`);
  for (const id of plan.locals.keys()) {
    const shadow = B.slot();
    B.entryAllocas.push(
      `${shadow} = alloca i64 ; speculative integer ${emitter.currentLocals.get(id)?.name ?? id}`,
    );
    const entry = entries.get(id);
    if (entry !== undefined) {
      // The same double, now visibly an integer conversion: the double
      // phis of the fast copy fold into integer phis.
      const exact = B.tmp();
      B.line(`store i64 ${entry}, ptr ${shadow}`);
      B.line(`${exact} = sitofp i64 ${entry} to double`);
      B.line(`store double ${exact}, ptr ${emitter.binding(id).slot}`);
    } else B.line(`store i64 0, ptr ${shadow}`);
    emitter.integerLoopBindings.set(id, {
      slot: shadow,
      type: "i64",
      signed: true,
      range: SPECULATIVE_RANGE,
    });
  }
  // A global's store stays in the loop (calls may read it). When nothing
  // in the loop can observe it, its double is written once on leaving the
  // copy instead, so the loop keeps it in a register as the double copy
  // would.
  const deferred = new Set<string>();
  // Worker loops also leave through their cancellation poll.
  if (plan.observerFree && !emitter.mod.workers)
    for (const s of plan.writes) {
      const id = speculativeWriteTarget(s)!.localId;
      if (!emitter.currentLocals.has(id)) deferred.add(id);
    }
  emitter.speculation = {
    writes: plan.writes,
    resume: new Map([...resume].map(([s, r]) => [s, r.label])),
    deferred,
    bails,
    ran,
  };
  try {
    const leave = B.newLabel("spec.leave");
    emitCopy(leave);
    B.startBlock(leave);
    emitter.writeBackDeferred(deferred);
    // An entry that never ran a speculated write (a loop of no iterations)
    // says nothing about the site.
    const wrote = B.tmp(),
      left = B.tmp(),
      counted = B.tmp(),
      both = B.tmp(),
      clear = B.newLabel("spec.clear");
    B.line(`${wrote} = load i1, ptr ${ran}`);
    B.line(`${left} = load atomic i8, ptr ${bails} unordered, align 1`);
    B.line(`${counted} = icmp ne i8 ${left}, 0`);
    B.line(`${both} = and i1 ${wrote}, ${counted}`);
    B.condBr(both, clear, exit);
    B.startBlock(clear);
    B.line(`store atomic i8 0, ptr ${bails} unordered, align 1`);
    B.br(exit);
  } finally {
    emitter.speculation = null;
    for (const id of plan.locals.keys()) emitter.integerLoopBindings.delete(id);
  }
}

/** An int32 kind loop (int32-kind-loops.ts). The entry test reads the kind
 * of each of the plan's arrays: when every one holds int32 slots the fast
 * copy runs, when every one holds doubles the wide copy, which reads and
 * writes them as double arrays, and otherwise (a plan with several arrays)
 * the mixed copy, which tests their kinds at each access. A failed store of
 * the fast copy re-executes in the third copy, which finishes its
 * iteration with kind tests and then enters the mixed copy, or the wide
 * copy when the plan has one array (it just widened). Each copy is emitted
 * by `ordinary`: the loop's plain copy when a store may fail, since a
 * proven integer loop keeps locals in shadows of its own copy that another
 * copy cannot resume from. */
function emitInt32KindLoop(
  emitter: LlEmitter,
  plan: Int32KindLoopPlan,
  exit: string,
  ordinary: (exit: string) => void,
): void {
  const B = emitter.B;
  const fn = emitter.currentFunctionName;
  const keys = new Set([...plan.arrays.keys()].map((id) => `${fn}\0${id}`));
  const several = keys.size > 1;
  let allInt32 = "true",
    allWide = "true";
  const and = (all: string, next: string): string => {
    if (all === "true") return next;
    const both = B.tmp();
    B.line(`${both} = and i1 ${all}, ${next}`);
    return both;
  };
  for (const ref of plan.arrays.values()) {
    const arr = emitter.emitStableReceiver(ref, []);
    const kindPtr = B.tmp(),
      kind = B.tmp(),
      isInt32 = B.tmp();
    B.line(
      `${kindPtr} = getelementptr inbounds %ScrArr, ptr ${arr.name}, i32 0, i32 ${SCR_ARR_FIELD.elem}`,
    );
    emitter.markMemoryPointer(kindPtr, "array:header");
    B.line(`${kind} = load i8, ptr ${kindPtr}${emitter.fieldAliasAttachment(kindPtr)}`);
    B.line(`${isInt32} = icmp eq i8 ${kind}, ${SCR_ELEM_I32}`);
    allInt32 = and(allInt32, isInt32);
    if (several) {
      const isWide = B.tmp();
      B.line(`${isWide} = xor i1 ${isInt32}, true`);
      allWide = and(allWide, isWide);
    }
  }
  const fast = B.newLabel("kind.fast"),
    wide = B.newLabel("kind.wide"),
    mixed = several ? B.newLabel("kind.mixed") : null;
  if (mixed === null) B.condBr(allInt32, fast, wide);
  else {
    const other = B.newLabel("kind.other");
    B.condBr(allInt32, fast, other);
    B.startBlock(other);
    B.condBr(allWide, wide, mixed);
  }
  const resume = new Map<IrStmt, { label: string; placed: boolean }>();
  for (const s of plan.writes) resume.set(s, { label: B.newLabel("kind.resume"), placed: false });
  // The header the third copy enters: the mixed copy's, or the wide copy's.
  let header: string | null = null;
  const capture = (label: string): void => {
    header = label;
  };
  B.startBlock(wide);
  if (resume.size > 0 && mixed === null) emitter.speculationHeader = capture;
  emitter.int32Kinds = { int32: new Set(), wide: keys, resume: new Map() };
  try {
    ordinary(exit);
  } finally {
    emitter.speculationHeader = null;
    emitter.int32Kinds = null;
  }
  if (mixed !== null) {
    B.startBlock(mixed);
    if (resume.size > 0) emitter.speculationHeader = capture;
    try {
      ordinary(exit);
    } finally {
      emitter.speculationHeader = null;
    }
  }
  if (resume.size > 0) {
    if (header === null)
      throw new InternalCompilerError("llvm emitter bug: int32 kind loop copy without a header");
    // A failed store finishes its iteration here, as in a speculative
    // integer loop's third copy.
    B.startBlock(B.newLabel("kind.tail"));
    emitter.speculationResume = resume;
    emitter.speculationHeader = () => {
      B.br(header!);
      B.startBlock(B.newLabel("kind.unused"));
    };
    try {
      ordinary(exit);
    } finally {
      emitter.speculationResume = null;
      emitter.speculationHeader = null;
    }
  }
  B.startBlock(fast);
  if (![...resume.values()].every((r) => r.placed)) {
    // A write the third copy never reached: this copy tests the kinds.
    ordinary(exit);
    return;
  }
  emitter.int32Kinds = {
    int32: keys,
    wide: new Set(),
    resume: new Map([...resume].map(([s, r]) => [s, r.label])),
  };
  try {
    ordinary(exit);
  } finally {
    emitter.int32Kinds = null;
  }
}

/** At the top of a loop copy's header: lets a speculative loop find its
 * ordinary copy's header, and keeps its third copy out of the loop. */
function enterLoopHeader(emitter: LlEmitter, header: string): void {
  const dispatch = emitter.speculationHeader;
  emitter.speculationHeader = null;
  dispatch?.(header);
}

/** A proven integer loop (speculative-integers.ts) for this loop, or null.
 * A shadowed local's double is stale until the loop is left, which only
 * the loop's exit, a return and an exception do: the loop is planned only
 * where an exception leaves the function (no enclosing try or finally, no
 * coroutine frame), so no handler reads the stale double. */
function planProvenLoop(
  emitter: LlEmitter,
  loop: Extract<IrStmt, { kind: "while" | "doWhile" | "for" }>,
): ProvenLoopPlan | null {
  if (
    loop.kind !== "for" ||
    !emitter.speculativeLoopsEnabled ||
    emitter.speculation !== null ||
    emitter.speculationResume !== null ||
    emitter.tryStack.length > 0 ||
    emitter.finallyStack.length > 0 ||
    emitter.currentCoro !== null
  )
    return null;
  const cursors = emitter.integerLoopRanges.get(loop);
  if (!cursors) return null;
  return planProvenIntegerLoop(
    loop,
    cursors,
    (id) => emitter.currentLocals.has(id) && emitter.speculativeLocal(id),
    (id) => emitter.integerLoopBindings.has(id) || emitter.int32Locals.has(id),
    (e) => {
      const range = emitter.integerRanges.get(e);
      return (
        range !== undefined &&
        range !== null &&
        range.min >= -Number.MAX_SAFE_INTEGER &&
        range.max <= Number.MAX_SAFE_INTEGER
      );
    },
  );
}

/** Emit a proven integer loop: its shadowed locals start from their
 * doubles (integers in their loop ranges on entry), its planned writes
 * compute integers into the shadows only, and leaving the loop through its
 * exit writes each double back. */
function emitProvenLoop(
  emitter: LlEmitter,
  plan: ProvenLoopPlan,
  exit: string,
  emitCopy: (exit: string) => void,
): void {
  const B = emitter.B;
  for (const [id, range] of plan.locals) {
    const shadow = B.slot();
    B.entryAllocas.push(
      `${shadow} = alloca i64 ; integer ${emitter.currentLocals.get(id)?.name ?? id}`,
    );
    const value = B.tmp(),
      integer = B.tmp();
    B.line(`${value} = load double, ptr ${emitter.binding(id).slot}`);
    B.line(`${integer} = fptosi double ${value} to i64`);
    B.line(`store i64 ${integer}, ptr ${shadow}`);
    emitter.integerLoopBindings.set(id, { slot: shadow, type: "i64", signed: true, range });
  }
  const deferred = new Set<string>();
  for (const id of plan.locals.keys()) deferred.add(id);
  emitter.speculation = { writes: plan.writes, resume: new Map(), deferred };
  try {
    const leave = B.newLabel("integer.leave");
    emitCopy(leave);
    B.startBlock(leave);
    emitter.writeBackDeferred(deferred);
    B.br(exit);
  } finally {
    emitter.speculation = null;
    for (const id of plan.locals.keys()) emitter.integerLoopBindings.delete(id);
  }
}

/** A speculated write in the fast copy: compute the value as a safe
 * integer, store it to the shadow and its exact double to the local.
 * Any failed check re-executes the statement in the ordinary copy. A
 * proven integer loop's write (no `resume`) has nothing to check. */
export function emitSpeculativeWrite(
  emitter: LlEmitter,
  s: IrStmt,
  resume: string | undefined,
): void {
  const B = emitter.B;
  const target = speculativeWriteTarget(s)!;
  const binding = emitter.integerLoopBindings.get(target.localId)!;
  const failed = B.newLabel("spec.bail");
  let bails = false;
  emitter.declare("declare i1 @llvm.expect.i1(i1, i1)");
  const bail = (condition: string): void => {
    if (condition === "false" || resume === undefined) return;
    bails = true;
    const expected = B.tmp();
    B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${condition}, i1 false)`);
    const next = B.newLabel("spec.ok");
    B.condBr(expected, failed, next);
    B.startBlock(next);
  };
  // Heap reads come first, before any check, and release their temporaries
  // at once: a bailing path then owns nothing, and reads have no effect
  // whose reordering before the arithmetic could be observed.
  const reads = new Map<IrExpr, LlValue>();
  if (target.value !== null) {
    emitter.frames.push([]);
    for (const read of speculativeReads(target.value)) reads.set(read, emitter.emitExpr(read));
    emitter.releaseTemps(emitter.frames.pop()!);
  }
  emitter.frames.push([]);
  let result: string;
  if (target.value === null) {
    const old = B.tmp();
    result = B.tmp();
    B.line(`${old} = load i64, ptr ${binding.slot}`);
    B.line(`${result} = ${target.op === "+" ? "add" : "sub"} nsw i64 ${old}, 1`);
    const biased = B.tmp(),
      outside = B.tmp();
    B.line(`${biased} = add i64 ${result}, ${Number.MAX_SAFE_INTEGER}`);
    B.line(`${outside} = icmp ugt i64 ${biased}, ${2 * Number.MAX_SAFE_INTEGER}`);
    bail(outside);
  } else result = emitSpeculativeInteger(emitter, target.value, bail, reads, resume === undefined);
  // Speculable values read only numbers past this point.
  if (emitter.frames.pop()!.length > 0)
    throw new InternalCompilerError("llvm emitter bug: speculative write owns a temporary");
  B.line(`store i64 ${result}, ptr ${binding.slot}`);
  const { deferred, bails: site, ran } = emitter.speculation!;
  if (ran !== undefined) B.line(`store i1 true, ptr ${ran}`);
  if (!deferred.has(target.localId)) {
    const number = B.tmp();
    B.line(`${number} = sitofp i64 ${result} to double`);
    B.line(`store double ${number}, ptr ${emitter.binding(target.localId).slot}`);
  }
  if (!bails) return;
  const done = B.newLabel("spec.done");
  B.br(done);
  B.startBlock(failed);
  emitter.writeBackDeferred(deferred);
  if (site !== undefined) {
    const count = B.tmp(),
      next = B.tmp();
    emitter.declare("declare i8 @llvm.uadd.sat.i8(i8, i8)");
    B.line(`${count} = load atomic i8, ptr ${site} unordered, align 1`);
    B.line(`${next} = call i8 @llvm.uadd.sat.i8(i8 ${count}, i8 1)`);
    B.line(`store atomic i8 ${next}, ptr ${site} unordered, align 1`);
  }
  B.br(resume!);
  B.startBlock(done);
}

/**
 * Lower canonical `target = target + suffix` after evaluating the old
 * left side and suffix in JavaScript order.  The snapshot stays owned by
 * the statement frame while the destination relinquishes its CURRENT
 * value, making the snapshot unique unless a real observable alias exists.
 */
export function emitStringSelfConcatAssign(
  emitter: LlEmitter,
  localId: string,
  left: IrExpr,
  suffix: IrExpr,
  retainForYield: boolean,
): LlValue {
  const moved = emitter.emitMovedSelfConcat(localId, left, suffix, retainForYield);
  if (moved) return moved;
  const snapshot = emitter.emitExpr(left);
  // A suffix of several parts, or a number, appends each operand to the
  // snapshot directly (in place once the binding lets go of it) instead
  // of first building the suffix as a separate string.
  const parts = stringParts(suffix);
  const mixed = parts.length > 1 || numberPart(parts[0]!) !== null;
  const charCode = mixed ? null : emitter.emitSingleCharCode(suffix);
  const inputs = mixed ? emitConcatInputs(emitter, parts) : [];
  // The concat only reads the suffix; relinquishing the binding below
  // runs no code that could rebind a borrowed local.
  const right = mixed || charCode !== null ? null : emitStringInputs(emitter, [suffix])[0]!;
  const b = emitter.binding(localId);
  const B = emitter.B;
  if (b.kind === "boxed") {
    // set_ref(NULL) unlinks then releases the binding's post-suffix value.
    emitter.boxSet(emitter.loadBox(b.slot), b.type, "null");
  } else {
    const old = B.tmp();
    B.line(`${old} = load ptr, ptr ${b.slot}`);
    B.line(`store ptr null, ptr ${b.slot}`);
    if (b.kind === "global") emitter.releaseHeap(old, b.type);
    else emitter.releaseFrame(old, b.type);
  }
  let raw: string;
  if (charCode !== null) {
    // The snapshot moves into the consuming character append.
    emitter.toFrame(snapshot);
    emitter.declare(`declare ptr @scr_str_concat_move_char_code(ptr, double)`);
    raw = B.tmp();
    B.line(
      `${raw} = call ptr @scr_str_concat_move_char_code(ptr ${snapshot.name}, double ${charCode.name})`,
    );
  } else if (right === null) {
    raw = emitMixedConcat(emitter, snapshot.name, inputs);
  } else {
    emitter.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
    raw = B.tmp();
    B.line(`${raw} = call ptr @scr_str_concat(ptr ${snapshot.name}, ptr ${right.name})`);
  }
  const result = emitter.own({ name: raw, type: left.type });
  if (retainForYield) {
    const stored =
      b.kind === "local"
        ? emitter.retainFrame(result.name, result.type)
        : emitter.retainHeap(result.name, result.type);
    if (b.kind === "boxed") emitter.boxSet(emitter.loadBox(b.slot), b.type, stored);
    else B.line(`store ptr ${stored}, ptr ${b.slot}`);
  } else {
    if (b.kind === "local") emitter.toFrame(result);
    else emitter.toHeap(result);
    if (b.kind === "boxed") emitter.boxSet(emitter.loadBox(b.slot), b.type, result.name);
    else B.line(`store ptr ${result.name}, ptr ${b.slot}`);
  }
  return result;
}

/** `switch (x)` on a `string | undefined` value whose case tests are all
 * string literals: the frontend's `switch (true)` over `x === "lit"` union
 * equalities against one switch local. The local and the cases with plain
 * string literal tests. */
function nullableStringSwitch(
  emitter: LlEmitter,
  s: IrStmt & { kind: "switch" },
): { value: IrExpr; cases: (IrStmt & { kind: "switch" })["cases"] } | null {
  if (s.disc.kind !== "boolLit" || !s.disc.value) return null;
  let value: (IrExpr & { kind: "varRef" }) | null = null;
  const cases: (IrStmt & { kind: "switch" })["cases"] = [];
  for (const c of s.cases) {
    const test = c.test;
    if (test === null) {
      cases.push(c);
      continue;
    }
    if (
      test.kind !== "unionEq" ||
      test.negated ||
      test.sameValue ||
      test.left.kind !== "varRef" ||
      test.right.kind !== "unionWrap" ||
      test.right.value.kind !== "strLit"
    )
      return null;
    const nullable = emitter.nullableUnions.get(test.unionId);
    if (
      nullable === null ||
      nullable.repr !== "single" ||
      nullable.nullTag !== -1 ||
      nullable.arm.kind !== "string" ||
      test.right.tag !== nullable.refTag
    )
      return null;
    if (value !== null && value.localId !== test.left.localId) return null;
    value = test.left;
    cases.push({ ...c, test: test.right.value });
  }
  return value === null ? null : { value, cases };
}

/** `switch (s.charAt(i))` (or `switch (s[i])`) whose case tests are all
 * one-unit string literals, as a switch on `s.charCodeAt(i)` with the units
 * as cases: no character string is built. An index out of range answers
 * NaN, which matches no case, as "" matches no one-unit literal. */
function charAtUnitSwitch(
  emitter: LlEmitter,
  s: IrStmt & { kind: "switch" },
): (IrStmt & { kind: "switch" }) | null {
  const disc = s.disc;
  if (disc.kind !== "strIntrinsic" || disc.method !== "charAt" || disc.args.length !== 1)
    return null;
  if (!s.cases.some((c) => c.test !== null)) return null;
  if (
    !s.cases.every(
      (c) => c.test === null || (c.test.kind === "strLit" && c.test.value.length === 1),
    )
  )
    return null;
  return {
    ...s,
    disc: charAtUnitRead(emitter, disc),
    cases: s.cases.map((c) =>
      c.test?.kind === "strLit"
        ? {
            ...c,
            test: { kind: "numLit", value: c.test.value.charCodeAt(0), type: F64, loc: c.test.loc },
          }
        : c,
    ),
  };
}
