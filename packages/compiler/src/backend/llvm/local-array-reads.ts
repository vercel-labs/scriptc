import {
  isRefCounted,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { analyzeCallLifetimes, type CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { ReferenceEffects } from "./reference-effects.js";

export interface LocalArrayRead {
  type: IrType;
  array: IrExpr;
  index: IrExpr;
  element: IrType;
  presentTag: number;
  missingTag: number;
  borrow?: boolean;
}

/** Kept as the array-analysis entry point; the same edge-preservation
 * proof also governs projections passed to borrowing consumers. */
export function findArrayPreservingFunctions(
  functions: ReadonlyMap<string, IrFunction>,
  unions: ReadonlyMap<string, IrUnionDef>,
  reads = new OptionalArrayReads(functions, unions),
): Set<string> {
  return new ReferenceEffects(functions, (call) => reads.get(call) !== null).functions;
}

interface ArrayReadShape {
  type: IrType;
  element: IrType;
  presentTag: number;
  missingTag: number;
}

/** Recognize the state-test/read pair shared by helpers and lowered loops.
 * Repeated operands must be plain bindings or numeric literals: folding an
 * effectful index or receiver would change evaluation count and ordering. */
function inlineArrayRead(
  value: IrExpr,
  unions: ReadonlyMap<string, IrUnionDef>,
): LocalArrayRead | null {
  if (value.kind !== "ternary" || value.type.kind !== "union") return null;
  const { cond, then, else_: missing } = value;
  if (
    cond.kind !== "bin" ||
    cond.op !== "===" ||
    cond.left.kind !== "arrayState" ||
    cond.right.kind !== "numLit" ||
    cond.right.value !== 1 ||
    then.kind !== "unionWrap" ||
    then.unionId !== value.type.unionId ||
    then.value.kind !== "arrayGet" ||
    missing.kind !== "unionWrap" ||
    missing.unionId !== value.type.unionId ||
    missing.value.kind !== "unitLit" ||
    missing.value.unit !== "undefined"
  )
    return null;
  const sameOperand = (left: IrExpr, right: IrExpr): boolean =>
    (left.kind === "varRef" && right.kind === "varRef" && left.localId === right.localId) ||
    (left.kind === "numLit" && right.kind === "numLit" && Object.is(left.value, right.value));
  const array = cond.left.arr,
    index = cond.left.index;
  if (
    array.kind !== "varRef" ||
    array.type.kind !== "array" ||
    index.type.kind !== "f64" ||
    !sameOperand(array, then.value.arr) ||
    !sameOperand(index, then.value.index)
  )
    return null;
  const element = array.type.elem;
  const arms = unions.get(value.type.unionId)?.arms;
  if (!isRefCounted(element) || element.kind === "union" || !arms || arms.length !== 2) return null;
  const presentTag = arms.findIndex((arm) => typeEquals(arm, element));
  const missingTag = arms.findIndex((arm) => arm.kind === "undefinedT");
  if (presentTag < 0 || missingTag < 0 || then.tag !== presentTag || missing.tag !== missingTag)
    return null;
  return { type: value.type, element, presentTag, missingTag, array, index };
}

/** Recognize the complete optional-array-read body, not the helper's name. */
function arrayReadShape(
  fn: IrFunction,
  unions: ReadonlyMap<string, IrUnionDef>,
): ArrayReadShape | null {
  if (
    fn.async ||
    fn.generator ||
    fn.captures ||
    fn.classCaptures ||
    fn.params.length !== 2 ||
    fn.body.length !== 1 ||
    fn.locals.length !== 2 ||
    fn.locals.some((local) => local.boxed || local.tdz)
  )
    return null;
  const ret = fn.body[0]!;
  if (ret.kind !== "return" || !ret.value) return null;
  const read = inlineArrayRead(ret.value, unions);
  if (
    !read ||
    !typeEquals(read.type, fn.returnType) ||
    read.array.kind !== "varRef" ||
    read.array.localId !== fn.params[0]!.localId ||
    read.index.kind !== "varRef" ||
    read.index.localId !== fn.params[1]!.localId
  )
    return null;
  return {
    type: read.type,
    element: read.element,
    presentTag: read.presentTag,
    missingTag: read.missingTag,
  };
}

/** One index for finalized IR, shared by effect and lifetime consumers.
 * Recognizing a helper once avoids rescanning its body for every read site.
 * Only operands vary between uses; payload ownership is proved separately. */
export class OptionalArrayReads {
  private readonly shapes = new Map<string, ArrayReadShape>();

  constructor(
    functions: ReadonlyMap<string, IrFunction>,
    private readonly unions: ReadonlyMap<string, IrUnionDef>,
  ) {
    for (const fn of functions.values()) {
      const shape = arrayReadShape(fn, unions);
      if (shape) this.shapes.set(fn.name, shape);
    }
  }

  get(call: IrExpr): LocalArrayRead | null {
    if (call.kind === "ternary") return inlineArrayRead(call, this.unions);
    if (call.kind !== "call" || call.args.length !== 2) return null;
    const shape = this.shapes.get(call.callee);
    if (!shape || !typeEquals(shape.type, call.type)) return null;
    return { ...shape, array: call.args[0]!, index: call.args[1]! };
  }
}

/** A body can preserve caller-owned edges while rebinding its own locals.
 * Borrowing an array element for the whole frame additionally requires
 * that the parameter holding the array is never replaced or captured. */
function stableArrayParameters(fn: IrFunction, lifetimes: CallLifetimes): Set<string> {
  const borrowed = lifetimes.borrowed.get(fn.name);
  return new Set(
    fn.params.filter((_, index) => borrowed?.has(index)).map((param) => param.localId),
  );
}

export function findLocalArrayReads(
  fn: IrFunction,
  functions: ReadonlyMap<string, IrFunction>,
  unions: ReadonlyMap<string, IrUnionDef>,
  arrayPreservingFunctions: ReadonlySet<string>,
  lifetimes: CallLifetimes = analyzeCallLifetimes(functions),
  reads = new OptionalArrayReads(functions, unions),
  loopBorrows: ReadonlySet<IrStmt> = new Set(),
): Map<string, LocalArrayRead> {
  const result = new Map<string, LocalArrayRead>();
  if (fn.async || fn.generator) return result;
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const captures = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const params = new Set(fn.params.map((p) => p.localId));
  const stableParams = stableArrayParameters(fn, lifetimes);
  const borrow = arrayPreservingFunctions.has(fn.name);
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (node) => {
      if (node.kind !== "varDecl" || !node.init) return true;
      const local = locals.get(node.localId);
      if (!local || local.boxed || local.tdz || captures.has(local.id) || params.has(local.id))
        return true;
      const read = reads.get(node.init);
      if (read && lifetimes.locals.get(fn.name)?.has(local.id)) {
        if (
          read.array.kind === "varRef" &&
          ((borrow && stableParams.has(read.array.localId)) || loopBorrows.has(node)) &&
          !locals.get(read.array.localId)?.boxed
        )
          read.borrow = true;
        result.set(local.id, read);
      }
      return true;
    },
  });
  return result;
}

/** An immediate argument needs no heap union when its parameter only
 * projects the box. The payload owns a snapshot through all later arguments
 * and the call, unless the enclosing function preserves its parameter's
 * array edges. The latter proof includes every later argument and callee,
 * so a mutation anywhere keeps the independent payload owner. */
export function findCallArrayReads(
  fn: IrFunction,
  reads: OptionalArrayReads,
  arrayPreservingFunctions: ReadonlySet<string>,
  lifetimes: CallLifetimes,
): Map<IrExpr, LocalArrayRead> {
  const result = new Map<IrExpr, LocalArrayRead>();
  if (fn.async || fn.generator) return result;
  const stableParams = stableArrayParameters(fn, lifetimes);
  const locals = new Map(fn.locals.map((local) => [local.id, local]));
  const borrow = arrayPreservingFunctions.has(fn.name);
  everyStmtList(fn.body, {
    stmt: () => true,
    expr: (node) => {
      if (node.kind !== "call") return true;
      const parameters = lifetimes.parameters.get(node.callee);
      if (!parameters) return true;
      node.args.forEach((arg, index) => {
        if (!parameters.has(index)) return;
        const read = reads.get(arg);
        if (!read) return;
        if (
          borrow &&
          read.array.kind === "varRef" &&
          stableParams.has(read.array.localId) &&
          !locals.get(read.array.localId)?.boxed
        )
          read.borrow = true;
        result.set(arg, read);
      });
      return true;
    },
  });
  return result;
}

/** Call-scoped owners are released by the existing argument frame on both
 * normal and exceptional exits. Each use gets a distinct stack box: nested
 * calls and repeated operands must never overwrite an earlier snapshot. */
export function emitCallArrayRead(host: LlvmEmitterContext, read: LocalArrayRead): LlValue {
  const slot = host.B.slot();
  host.B.entryAllocas.push(`${slot} = alloca ptr`);
  // Snapshot arguments already cross a runtime ownership boundary. Keep
  // their lookup compact instead of duplicating the dense fast path at
  // every call site; proven borrowed reads still expose that path to LLVM.
  const owner = emitLocalArrayRead(host, read, slot, read.borrow === true);
  if (owner) host.ownSlot(owner.slot, owner.type);
  const value = host.B.tmp();
  host.B.line(`${value} = load ptr, ptr ${slot}`);
  return { name: value, type: read.type };
}

/** A tag or payload projection consumes the box before its frame ends. The
 * payload owns one reference, so later operands may mutate the array without
 * invalidating the snapshot; the box itself never reaches runtime code. */
export function emitProjectedArrayRead(host: LlvmEmitterContext, read: LocalArrayRead): LlValue {
  const slot = host.B.slot();
  host.B.entryAllocas.push(`${slot} = alloca ptr`);
  const owner = emitLocalArrayRead(host, { ...read, borrow: false }, slot);
  if (owner) host.ownSlot(owner.slot, owner.type);
  const value = host.B.tmp();
  host.B.line(`${value} = load ptr, ptr ${slot}`);
  return { name: value, type: read.type };
}

/** Share the checked dense lookup between optional stack boxes and strict
 * borrowed reads. Capacity, length, and presence guards precede every load;
 * sparse and noncanonical indices keep their runtime lookup semantics. */
function emitDenseReferenceArrayRead(
  host: LlvmEmitterContext,
  array: LlValue,
  index: LlValue,
  integerIndex: string | null,
  present: (value: string) => void,
  no: string,
  slow: string,
  join: string,
): void {
  const B = host.B;
  const range = B.newLabel("local.array.range"),
    dense = B.newLabel("local.array.dense");
  // The dense path uses the existing ScrArr ABI. Sparse indices and
  // noncanonical numeric properties retain the runtime lookup semantics.
  const capPtr = B.tmp(),
    cap = B.tmp(),
    capNumber = B.tmp(),
    nonnegative = B.tmp(),
    belowCap = B.tmp(),
    inRange = B.tmp();
  B.line(`${capPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 2`);
  host.markMemoryPointer(capPtr, "array:header");
  B.line(`${cap} = load ${host.sizeType}, ptr ${capPtr}${host.fieldAliasAttachment(capPtr)}`);
  if (integerIndex) B.line(`${inRange} = icmp ult ${host.sizeType} ${integerIndex}, ${cap}`);
  else {
    B.line(`${capNumber} = uitofp ${host.sizeType} ${cap} to double`);
    B.line(`${nonnegative} = fcmp oge double ${index.name}, 0.0`);
    B.line(`${belowCap} = fcmp olt double ${index.name}, ${capNumber}`);
    B.line(`${inRange} = and i1 ${nonnegative}, ${belowCap}`);
  }
  B.condBr(inRange, range, slow);
  B.startBlock(range);
  const offset = integerIndex ?? B.tmp(),
    roundTrip = B.tmp(),
    integral = B.tmp();
  if (integerIndex) B.br(dense);
  else {
    B.line(`${offset} = fptoui double ${index.name} to ${host.sizeType}`);
    B.line(`${roundTrip} = uitofp ${host.sizeType} ${offset} to double`);
    B.line(`${integral} = fcmp oeq double ${index.name}, ${roundTrip}`);
    B.condBr(integral, dense, slow);
  }
  B.startBlock(dense);
  const lenPtr = B.tmp(),
    len = B.tmp(),
    belowLen = B.tmp();
  B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 1`);
  host.markMemoryPointer(lenPtr, "array:header");
  B.line(`${len} = load ${host.sizeType}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  B.line(`${belowLen} = icmp ult ${host.sizeType} ${offset}, ${len}`);
  const stateLabel = B.newLabel("local.array.state"),
    valueLabel = B.newLabel("local.array.value");
  B.condBr(belowLen, stateLabel, no);
  B.startBlock(stateLabel);
  const statesPtr = B.tmp(),
    states = B.tmp(),
    statePtr = B.tmp(),
    denseState = B.tmp(),
    densePresent = B.tmp();
  B.line(`${statesPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 8`);
  host.markMemoryPointer(statesPtr, "array:header");
  B.line(`${states} = load ptr, ptr ${statesPtr}${host.fieldAliasAttachment(statesPtr)}`);
  B.line(`${statePtr} = getelementptr inbounds i8, ptr ${states}, ${host.sizeType} ${offset}`);
  host.markMemoryPointer(statePtr, "array:present");
  B.line(`${denseState} = load i8, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
  B.line(`${densePresent} = icmp eq i8 ${denseState}, 1`);
  B.condBr(densePresent, valueLabel, no);
  B.startBlock(valueLabel);
  const dataPtr = B.tmp(),
    data = B.tmp(),
    valuePtr = B.tmp(),
    raw = B.tmp();
  B.line(`${dataPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 7`);
  host.markMemoryPointer(dataPtr, "array:header");
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  B.line(`${valuePtr} = getelementptr inbounds i64, ptr ${data}, ${host.sizeType} ${offset}`);
  host.markMemoryPointer(valuePtr, "array:elements");
  B.line(`${raw} = load ptr, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  present(raw);
  B.br(join);
}

/** An iteration-preserving proof keeps the array's element alive. Dense
 * values need no runtime call; every exceptional lookup still uses the same
 * strict hole and missing-property checks as an ordinary owned read. */
export function emitBorrowedArrayRead(
  host: LlvmEmitterContext,
  read: IrExpr & { kind: "arrayGet" },
  slot: string,
): void {
  const B = host.B;
  const array = host.emitStableReceiver(read.arr, [read.index]);
  const integerIndex = host.emitIntegerLoopIndex(read.index);
  const index = host.emitExpr(read.index);
  const slow = B.newLabel("borrow.array.slow"),
    join = B.newLabel("borrow.array.join");
  emitDenseReferenceArrayRead(
    host,
    array,
    index,
    integerIndex,
    (value) => B.line(`store ptr ${value}, ptr ${slot}`),
    slow,
    slow,
    join,
  );
  B.startBlock(slow);
  host.declare("declare ptr @scr_arr_borrow_ref(ptr, double)");
  const value = B.tmp();
  B.line(`${value} = call ptr @scr_arr_borrow_ref(ptr ${array.name}, double ${index.name})`);
  B.line(`store ptr ${value}, ptr ${slot}`);
  B.br(join);
  B.startBlock(join);
}

/** A private stack box keeps the ordinary tag/projection ABI. Its payload
 * either borrows from an array parameter proven to keep it alive, or owns
 * one reference released on every lexical exit, including exceptions. The
 * box never reaches runtime code; LLVM can scalar-replace its slots. */
export function emitLocalArrayRead(
  host: LlvmEmitterContext,
  read: LocalArrayRead,
  localSlot: string,
  inline = true,
): { slot: string; type: IrType } | null {
  const B = host.B;
  const array = host.emitStableReceiver(read.array, [read.index]);
  const integerIndex = inline ? host.emitIntegerLoopIndex(read.index) : null;
  const index = host.emitExpr(read.index);
  const box = B.slot(),
    payload = B.slot(),
    tag = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  const slow = B.newLabel("local.array.slow");
  const no = B.newLabel("local.array.missing"),
    join = B.newLabel("local.array.join");
  const storeValue = (value: string): void => {
    B.line(
      `store ptr ${read.borrow ? value : host.retainValue(value, read.element)}, ptr ${payload}`,
    );
    B.line(`store i32 ${read.presentTag}, ptr ${tag}`);
  };
  if (inline)
    emitDenseReferenceArrayRead(host, array, index, integerIndex, storeValue, no, slow, join);
  else B.br(slow);
  B.startBlock(slow);
  const value = B.tmp(),
    present = B.tmp();
  host.declare("declare ptr @scr_arr_peek_ref(ptr, double) memory(read)");
  B.line(`${value} = call ptr @scr_arr_peek_ref(ptr ${array.name}, double ${index.name})`);
  B.line(`${present} = icmp ne ptr ${value}, null`);
  const slowValue = B.newLabel("local.array.slow.value");
  B.condBr(present, slowValue, no);
  B.startBlock(slowValue);
  storeValue(value);
  B.br(join);
  B.startBlock(no);
  B.line(`store ptr null, ptr ${payload}`);
  B.line(`store i32 ${read.missingTag}, ptr ${tag}`);
  B.br(join);
  B.startBlock(join);
  B.line(`store ptr ${box}, ptr ${localSlot}`);
  return read.borrow ? null : { slot: payload, type: read.element };
}
