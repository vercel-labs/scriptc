import {
  isRefCounted,
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { analyzeCallLifetimes, type CallLifetimes } from "./call-lifetimes.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { ReferenceEffects } from "./reference-effects.js";
import { SCR_ARR_FIELD, loadArrCount, scrArrStateAt } from "./common.js";
import { indexInteger } from "./integer-values.js";
import { READ_FALLBACK } from "./dense-array-access.js";
import { compactRefLoadLines } from "./classes.js";

/** The dense slot load of a reference read from an array of type
 * `arrayType`: a pointer, or a compact class reference (SCR_ELEM_CREF). */
function referenceLoad(host: LlvmEmitterContext, arrayType: IrType): "ptr" | "cref" {
  return arrayType.kind === "array" && host.compactArrayElem(arrayType.elem) ? "cref" : "ptr";
}

export interface LocalArrayRead {
  type: IrType;
  array: IrExpr;
  index: IrExpr;
  element: IrType;
  presentTag: number;
  missingTag: number;
  borrow?: boolean;
  /** The array's elements are themselves the read's `T | undefined`
   * nullable-pointer union, so a present slot may hold NULL (undefined):
   * owned copies retain and release through the union's NULL-tolerant
   * entry points. */
  nullableElement?: boolean;
}

/** Whether a union is held as its reference arm's plain pointer
 * (nullable-unions.ts). Without it, only reference elements are matched. */
export type NullablePointerUnion = (unionId: string) => boolean;

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
  nullableElement?: boolean;
}

/** f64 and bool elements copy their slot bits into the box payload. They
 * have no owner, so every lifetime proof for them is trivially satisfied. */
function isScalarElement(element: IrType): boolean {
  return element.kind === "f64" || element.kind === "bool";
}

/** Recognize the state-test/read pair shared by helpers and lowered loops.
 * Repeated operands must be plain bindings or numeric literals: folding an
 * effectful index or receiver would change evaluation count and ordering. */
function inlineArrayRead(
  value: IrExpr,
  unions: ReadonlyMap<string, IrUnionDef>,
  nullable?: NullablePointerUnion,
): LocalArrayRead | null {
  if (value.kind !== "ternary" || value.type.kind !== "union") return null;
  const { cond, then, else_: missing } = value;
  if (
    cond.kind !== "bin" ||
    cond.op !== "===" ||
    cond.left.kind !== "arrayState" ||
    cond.right.kind !== "numLit" ||
    cond.right.value !== 1 ||
    missing.kind !== "unionWrap" ||
    missing.unionId !== value.type.unionId ||
    missing.value.kind !== "unitLit" ||
    missing.value.unit !== "undefined"
  )
    return null;
  // A `T | undefined` element is read as it is (arrayValueRead adds no wrap).
  const elementRead =
    then.kind === "unionWrap" && then.unionId === value.type.unionId
      ? then.value
      : then.kind === "arrayGet" && typeEquals(then.type, value.type)
        ? then
        : null;
  if (elementRead?.kind !== "arrayGet") return null;
  const sameOperand = (left: IrExpr, right: IrExpr): boolean =>
    (left.kind === "varRef" && right.kind === "varRef" && left.localId === right.localId) ||
    (left.kind === "numLit" && right.kind === "numLit" && Object.is(left.value, right.value));
  const array = cond.left.arr,
    index = cond.left.index;
  if (
    array.kind !== "varRef" ||
    array.type.kind !== "array" ||
    index.type.kind !== "f64" ||
    !sameOperand(array, elementRead.arr) ||
    !sameOperand(index, elementRead.index)
  )
    return null;
  const arms = unions.get(value.type.unionId)?.arms;
  if (!arms || arms.length !== 2) return null;
  const missingTag = arms.findIndex((arm) => arm.kind === "undefinedT");
  if (missingTag < 0 || missing.tag !== missingTag) return null;
  if (then === elementRead) {
    // The slots hold the union itself: only its plain-pointer form (NULL is
    // undefined) shares the element encoding of the reference-arm reads.
    const presentTag = 1 - missingTag;
    const element = arms[presentTag]!;
    if (
      !typeEquals(array.type.elem, value.type) ||
      !isRefCounted(element) ||
      nullable?.(value.type.unionId) !== true
    )
      return null;
    return {
      type: value.type,
      element,
      presentTag,
      missingTag,
      array,
      index,
      nullableElement: true,
    };
  }
  const element = array.type.elem;
  if ((!isRefCounted(element) && !isScalarElement(element)) || element.kind === "union")
    return null;
  const presentTag = arms.findIndex((arm) => typeEquals(arm, element));
  if (presentTag < 0 || then.kind !== "unionWrap" || then.tag !== presentTag) return null;
  return { type: value.type, element, presentTag, missingTag, array, index };
}

/** Recognize the complete optional-array-read body, not the helper's name. */
function arrayReadShape(
  fn: IrFunction,
  unions: ReadonlyMap<string, IrUnionDef>,
  nullable?: NullablePointerUnion,
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
  const read = inlineArrayRead(ret.value, unions, nullable);
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
    ...(read.nullableElement ? { nullableElement: true } : {}),
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
    private readonly nullable?: NullablePointerUnion,
  ) {
    for (const fn of functions.values()) {
      const shape = arrayReadShape(fn, unions, nullable);
      if (shape) this.shapes.set(fn.name, shape);
    }
  }

  get(call: IrExpr): LocalArrayRead | null {
    if (call.kind === "ternary") return inlineArrayRead(call, this.unions, this.nullable);
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
  // Borrowed walk parameters may be rebound by statements (walk-borrows.ts).
  const rebound = new Set<string>();
  everyStmtList(fn.body, {
    stmt: (stmt) => {
      if (stmt.kind === "assign") rebound.add(stmt.localId);
      return true;
    },
    expr: () => true,
  });
  return new Set(
    fn.params
      .filter((param, index) => borrowed?.has(index) && !rebound.has(param.localId))
      .map((param) => param.localId),
  );
}

/** The array operand of a borrowed read: a stable parameter, or a pure
 * projection chain (fields, narrowing, casts) rooted at one. In a function
 * that preserves every heap edge, the caller-owned parameter keeps each
 * projected field, the array, and its elements alive for the whole frame. */
function stableArrayOperand(
  array: IrExpr,
  stableParams: ReadonlySet<string>,
  locals: ReadonlyMap<string, IrLocal>,
): boolean {
  switch (array.kind) {
    case "varRef":
      return stableParams.has(array.localId) && !locals.get(array.localId)?.boxed;
    case "fieldGet":
    case "recordGet":
      return stableArrayOperand(array.obj, stableParams, locals);
    case "unionNarrow":
    case "downcast":
    case "upcast":
      return stableArrayOperand(array.value, stableParams, locals);
    default:
      return false;
  }
}

interface StatementPosition {
  list: readonly IrStmt[];
  index: number;
}

/** The statement list and index of every statement of a body. Statements
 * nested in expressions (sequence statements) and `for` initializers are
 * absent: their declarations keep the frame-wide proof alone. */
function statementPositions(body: readonly IrStmt[]): Map<IrStmt, StatementPosition> {
  const positions = new Map<IrStmt, StatementPosition>();
  const visit = (list: readonly IrStmt[]): void => {
    list.forEach((stmt, index) => {
      positions.set(stmt, { list, index });
      switch (stmt.kind) {
        case "if":
          visit(stmt.then);
          if (stmt.else_) visit(stmt.else_);
          break;
        case "while":
        case "doWhile":
        case "for":
        case "forOf":
        case "block":
          visit(stmt.body);
          break;
        case "switch":
          for (const c of stmt.cases) visit(c.body);
          break;
        case "tryCatch":
          visit(stmt.tryBody);
          if (stmt.catchBody) visit(stmt.catchBody);
          if (stmt.finallyBody) visit(stmt.finallyBody);
          break;
      }
    });
  };
  visit(body);
  return positions;
}

function countReferences(body: readonly IrStmt[], localId: string): number {
  let count = 0;
  everyStmtList(body as IrStmt[], {
    stmt: () => true,
    expr: (e) => {
      if (e.kind === "varRef" && e.localId === localId) count++;
      return true;
    },
  });
  return count;
}

/** A declaration whose whole live range preserves heap edges: every use
 * of the local follows it in its own statement list, and neither its
 * initializer nor any statement up to the last use can remove a reference
 * (effects as in ReferenceEffects). The array operand, rooted at a stable
 * parameter, then keeps the element alive until the local is dead, though
 * other code of the function may mutate. */
function preservingLiveRange(
  decl: IrStmt & { kind: "varDecl" },
  positions: ReadonlyMap<IrStmt, StatementPosition>,
  body: readonly IrStmt[],
  effects: ReferenceEffects,
): boolean {
  const position = positions.get(decl);
  if (!position || !decl.init || !effects.preserves(decl.init)) return false;
  const { list, index } = position;
  let last = index,
    seen = 0;
  for (let i = index + 1; i < list.length; i++) {
    const count = countReferences([list[i]!], decl.localId);
    if (count === 0) continue;
    last = i;
    seen += count;
  }
  return (
    seen === countReferences(body, decl.localId) &&
    effects.preservesScope(list.slice(index + 1, last + 1) as IrStmt[])
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
  effects?: ReferenceEffects,
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
  let positions: Map<IrStmt, StatementPosition> | undefined;
  everyStmtList(fn.body, {
    expr: () => true,
    stmt: (node) => {
      if (node.kind !== "varDecl" || !node.init) return true;
      const local = locals.get(node.localId);
      if (!local || local.boxed || local.tdz || captures.has(local.id) || params.has(local.id))
        return true;
      const read = reads.get(node.init);
      if (read && lifetimes.locals.get(fn.name)?.has(local.id)) {
        const stable = stableArrayOperand(read.array, stableParams, locals);
        if (
          (borrow && stable) ||
          (read.array.kind === "varRef" &&
            loopBorrows.has(node) &&
            !locals.get(read.array.localId)?.boxed) ||
          (stable &&
            effects !== undefined &&
            preservingLiveRange(
              node,
              (positions ??= statementPositions(fn.body)),
              fn.body,
              effects,
            ))
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
 * and the call, unless the enclosing function, or the call itself with all
 * of its arguments, preserves its parameter's array edges. That proof
 * includes every later argument and callee, so a mutation anywhere keeps
 * the independent payload owner. */
export function findCallArrayReads(
  fn: IrFunction,
  reads: OptionalArrayReads,
  arrayPreservingFunctions: ReadonlySet<string>,
  lifetimes: CallLifetimes,
  effects?: ReferenceEffects,
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
          (borrow || effects?.preserves(node) === true) &&
          stableArrayOperand(read.array, stableParams, locals)
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
export function emitCallArrayRead(
  host: LlvmEmitterContext,
  read: LocalArrayRead,
  inline?: boolean,
): LlValue {
  const slot = host.B.slot();
  host.B.entryAllocas.push(`${slot} = alloca ptr`);
  // Snapshot arguments already cross a runtime ownership boundary. Keep
  // boxed lookups compact instead of duplicating the dense fast path at
  // every call site; proven borrowed reads, immediate projections (tests,
  // narrowing, comparisons), and nullable references (the element pointer
  // itself, so the dense path is a few loads) still expose it to LLVM.
  const nullable = read.type.kind === "union" && host.nullableUnions.has(read.type.unionId);
  const owner = emitLocalArrayRead(host, read, slot, inline ?? (read.borrow === true || nullable));
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
 * sparse and noncanonical indices keep their runtime lookup semantics.
 * `induction` says `integerIndex` is a loop's induction variable. */
function emitDenseReferenceArrayRead(
  host: LlvmEmitterContext,
  array: LlValue,
  index: LlValue,
  integerIndex: string | null,
  induction: boolean,
  present: (value: string) => void,
  no: string,
  slow: string,
  join: string,
  /** `i32`: an int32 array's slot, presented as the int32. */
  loadType: "ptr" | "cref" | "i64" | "i8" | "i32" = "ptr",
): void {
  const B = host.B;
  const header = (field: number): string => {
    const ptr = B.tmp();
    B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 ${field}`);
    host.markMemoryPointer(ptr, "array:header");
    return ptr;
  };
  const valueLabel = B.newLabel("local.array.value");
  // `key` is the index compared with the array's counts and `offset` the
  // index that addresses its slots. A double index that is not an exact
  // integer, like a sparse or noncanonical one, keeps the runtime lookup
  // semantics; an exact one compares as i64, which a 32-bit target does
  // before truncating it.
  let key: string, keyType: string, offset: string;
  if (integerIndex) {
    key = offset = integerIndex;
    keyType = host.sizeType;
  } else {
    const raw = B.tmp(),
      back = B.tmp(),
      integral = B.tmp(),
      exact = B.newLabel("local.array.exact");
    key = B.tmp();
    keyType = "i64";
    B.line(`${raw} = fptosi double ${index.name} to i64`);
    B.line(`${key} = freeze i64 ${raw}`);
    B.line(`${back} = sitofp i64 ${key} to double`);
    B.line(`${integral} = fcmp oeq double ${back}, ${index.name}`);
    B.condBr(integral, exact, slow);
    B.startBlock(exact);
    offset = key;
    if (host.sizeType !== "i64") {
      offset = B.tmp();
      B.line(`${offset} = trunc i64 ${key} to ${host.sizeType}`);
    }
  }
  const widen = (count: string, type: string): string => {
    if (type === keyType) return count;
    const wide = B.tmp();
    B.line(`${wide} = zext ${type} ${count} to ${keyType}`);
    return wide;
  };
  // The state and value paths both index from `data`: one load serves both.
  const dataPtr = header(SCR_ARR_FIELD.data),
    data = B.tmp();
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  // Below the hole-free prefix every state is a present value, and the
  // prefix is at most the length and the capacity, so an index below it needs
  // no other test before the value load.
  const filledPtr = header(SCR_ARR_FIELD.filled),
    filled = B.tmp(),
    prefix = B.tmp();
  B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  B.line(`${prefix} = icmp ult ${keyType} ${key}, ${widen(filled, "i32")}`);
  if (induction) {
    // The state of slot i is at data + cap * (width + 1) - 1 - i, and an
    // inline state check makes LLVM keep -1 - i as a second induction
    // variable in the loop; above the prefix the runtime reads the slot.
    B.condBr(prefix, valueLabel, slow);
  } else {
    const range = B.newLabel("local.array.range"),
      dense = B.newLabel("local.array.dense");
    B.condBr(prefix, valueLabel, range);
    B.startBlock(range);
    const capPtr = header(SCR_ARR_FIELD.cap),
      cap = B.tmp(),
      inRange = B.tmp();
    loadArrCount(host, cap, capPtr, host.fieldAliasAttachment(capPtr));
    B.line(`${inRange} = icmp ult ${keyType} ${key}, ${widen(cap, host.sizeType)}`);
    B.condBr(inRange, dense, slow);
    // Within the capacity and above the prefix, a slot below the length is
    // present when its state is.
    B.startBlock(dense);
    const lenPtr = header(SCR_ARR_FIELD.len),
      len = B.tmp(),
      belowLen = B.tmp();
    loadArrCount(host, len, lenPtr, host.fieldAliasAttachment(lenPtr));
    B.line(`${belowLen} = icmp ult ${host.sizeType} ${offset}, ${len}`);
    const stateLabel = B.newLabel("local.array.state");
    B.condBr(belowLen, stateLabel, no);
    B.startBlock(stateLabel);
    const statePtr = B.tmp(),
      denseState = B.tmp(),
      densePresent = B.tmp();
    scrArrStateAt(
      host,
      statePtr,
      data,
      cap,
      loadType === "i8" ? 1 : loadType === "cref" || loadType === "i32" ? 4 : 8,
      offset,
    );
    host.markMemoryPointer(statePtr, "array:present");
    B.line(`${denseState} = load i8, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
    B.line(`${densePresent} = icmp eq i8 ${denseState}, 1`);
    B.condBr(densePresent, valueLabel, no);
  }
  B.startBlock(valueLabel);
  const valuePtr = B.tmp(),
    raw = B.tmp();
  // Boolean arrays store one byte per element, compact references and int32
  // arrays four, every other kind an 8-byte slot.
  const slotType =
    loadType === "i8" ? "i8" : loadType === "cref" || loadType === "i32" ? "i32" : "i64";
  B.line(
    `${valuePtr} = getelementptr inbounds ${slotType}, ptr ${data}, ${host.sizeType} ${offset}`,
  );
  host.markMemoryPointer(valuePtr, "array:elements");
  if (loadType === "cref") {
    const ref = B.tmp();
    B.line(`${ref} = load i32, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    for (const line of compactRefLoadLines(ref, raw, `${raw}.r`)) B.line(line.trimStart());
  } else {
    B.line(`${raw} = load ${loadType}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  }
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
  const loopIndex = host.emitIntegerLoopIndex(read.index);
  if (loopIndex !== null && host.provenDenseIndex(read.arr, read.index)) {
    // In a dense array loop's fast copy, the entry test proved the counter
    // below the array's hole-free prefix: the slot holds a present value.
    const dataPtr = B.tmp(),
      data = B.tmp(),
      valuePtr = B.tmp(),
      value = B.tmp();
    B.line(
      `${dataPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 ${SCR_ARR_FIELD.data}`,
    );
    host.markMemoryPointer(dataPtr, "array:header");
    B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
    if (referenceLoad(host, read.arr.type) === "cref") {
      // Compact references: 4-byte slots holding the address over 8.
      const ref = B.tmp();
      B.line(
        `${valuePtr} = getelementptr inbounds i32, ptr ${data}, ${host.sizeType} ${loopIndex}`,
      );
      host.markMemoryPointer(valuePtr, "array:elements");
      B.line(`${ref} = load i32, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
      for (const line of compactRefLoadLines(ref, value, `${value}.r`)) B.line(line.trimStart());
      B.line(`store ptr ${value}, ptr ${slot}`);
      return;
    }
    B.line(`${valuePtr} = getelementptr inbounds i64, ptr ${data}, ${host.sizeType} ${loopIndex}`);
    host.markMemoryPointer(valuePtr, "array:elements");
    B.line(`${value} = load ptr, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    B.line(`store ptr ${value}, ptr ${slot}`);
    return;
  }
  const index = host.emitExpr(read.index);
  // A proven integer index (an int32 local, say), or a wide view exact at
  // every index below the capacity, needs no double round-trip; a negative
  // one compares above the capacity as unsigned.
  const integerIndex =
    loopIndex ?? (host.sizeType === "i64" ? indexInteger(host, index, read.index) : null);
  const slow = B.newLabel("borrow.array.slow"),
    join = B.newLabel("borrow.array.join");
  emitDenseReferenceArrayRead(
    host,
    array,
    index,
    integerIndex,
    loopIndex !== null,
    (value) => B.line(`store ptr ${value}, ptr ${slot}`),
    slow,
    slow,
    join,
    referenceLoad(host, read.arr.type),
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
  const loopIndex = inline ? host.emitIntegerLoopIndex(read.index) : null;
  const index = host.emitExpr(read.index);
  // As in emitBorrowedArrayRead: an exact integer or wide view needs no
  // round trip, and only the loop's own counter is an induction variable.
  const integerIndex =
    loopIndex ?? (inline && host.sizeType === "i64" ? indexInteger(host, index, read.index) : null);
  const nullable = read.type.kind === "union" ? host.nullableUnions.get(read.type.unionId) : null;
  if (nullable) {
    // A nullable union is the element pointer itself: borrowed from an
    // array proven to keep it alive, or one owned reference the caller
    // releases from this slot. The missing arm is its unit encoding.
    const slow = B.newLabel("local.array.slow"),
      no = B.newLabel("local.array.missing"),
      join = B.newLabel("local.array.join");
    // A slot of a nullable-union array may hold NULL even when present.
    const owned = read.nullableElement ? read.type : read.element;
    const store = (value: string): void => {
      B.line(`store ptr ${read.borrow ? value : host.retainFrame(value, owned)}, ptr ${localSlot}`);
    };
    if (inline)
      emitDenseReferenceArrayRead(
        host,
        array,
        index,
        integerIndex,
        loopIndex !== null,
        store,
        no,
        slow,
        join,
        referenceLoad(host, read.array.type),
      );
    else B.br(slow);
    B.startBlock(slow);
    const present = B.newLabel("local.array.slow.value");
    host.declare("declare ptr @scr_arr_peek_ref(ptr, double) memory(read)");
    const value = B.tmp(),
      found = B.tmp();
    B.line(`${value} = call ptr @scr_arr_peek_ref(ptr ${array.name}, double ${index.name})`);
    B.line(`${found} = icmp ne ptr ${value}, null`);
    B.condBr(found, present, no);
    B.startBlock(present);
    store(value);
    B.br(join);
    B.startBlock(no);
    B.line(
      `store ptr ${host.unitInstanceRef(nullable.unionId, read.missingTag)}, ptr ${localSlot}`,
    );
    B.br(join);
    B.startBlock(join);
    return read.borrow ? null : { slot: localSlot, type: owned };
  }
  const box = B.slot(),
    payload = B.slot(),
    tag = B.slot();
  B.entryAllocas.push(`${box} = alloca %ScrUnion`);
  B.entryAllocas.push(`${payload} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 5`);
  B.entryAllocas.push(`${tag} = getelementptr inbounds %ScrUnion, ptr ${box}, i32 0, i32 1`);
  const slow = B.newLabel("local.array.slow");
  const no = B.newLabel("local.array.missing"),
    join = B.newLabel("local.array.join");
  const scalar = isScalarElement(read.element);
  // An int32 array's arms join on the int32 element, converted to the
  // payload's double once at the join, so a consumer converting the payload
  // back to an integer folds to the element.
  const int32 = scalar && read.element.kind === "f64" && host.int32Array(read.array);
  const element = int32 ? B.slot() : null;
  if (element) B.entryAllocas.push(`${element} = alloca i32`);
  const storeValue = (value: string): void => {
    if (element) B.line(`store i32 ${value}, ptr ${element}`);
    else if (scalar) {
      // Slot bits for f64; a canonical 0/1 for bool, like scr_union_new_bool.
      let bits = value;
      if (read.element.kind === "bool") {
        const nonzero = B.tmp();
        bits = B.tmp();
        B.line(`${nonzero} = icmp ne i8 ${value}, 0`);
        B.line(`${bits} = zext i1 ${nonzero} to i64`);
      }
      B.line(`store i64 ${bits}, ptr ${payload}`);
    } else {
      B.line(
        `store ptr ${read.borrow ? value : host.retainFrame(value, read.element)}, ptr ${payload}`,
      );
    }
    B.line(`store i32 ${read.presentTag}, ptr ${tag}`);
  };
  if (inline && scalar && host.checkedInt32Array(read.array))
    // An int32 array with checked stores: its int32 arm stores the element's
    // double bits, as the double arm does.
    host.emitByElementKind(array.name, null, (kind) => {
      const present =
        kind === "i32"
          ? (value: string): void => {
              const number = B.tmp(),
                bits = B.tmp();
              B.line(`${number} = sitofp i32 ${value} to double`);
              B.line(`${bits} = bitcast double ${number} to i64`);
              storeValue(bits);
            }
          : storeValue;
      const loadType = kind === "i32" ? "i32" : "i64";
      const induction = loopIndex !== null;
      emitDenseReferenceArrayRead(
        host,
        array,
        index,
        integerIndex,
        induction,
        present,
        no,
        slow,
        join,
        loadType,
      );
      return null;
    });
  else if (
    inline &&
    loopIndex !== null &&
    read.element.kind === "f64" &&
    host.provenDenseIndex(read.array, read.index)
  ) {
    // In a dense array loop's fast copy, the entry test proved the counter
    // below the array's hole-free prefix: the slot holds a present value,
    // and the read has no missing arm.
    const dataPtr = B.tmp(),
      data = B.tmp(),
      valuePtr = B.tmp(),
      value = B.tmp(),
      width = int32 ? "i32" : "i64";
    B.line(
      `${dataPtr} = getelementptr inbounds %ScrArr, ptr ${array.name}, i32 0, i32 ${SCR_ARR_FIELD.data}`,
    );
    host.markMemoryPointer(dataPtr, "array:header");
    B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
    B.line(
      `${valuePtr} = getelementptr inbounds ${width}, ptr ${data}, ${host.sizeType} ${loopIndex}`,
    );
    host.markMemoryPointer(valuePtr, "array:elements");
    B.line(`${value} = load ${width}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    storeValue(value);
    B.br(join);
  } else if (inline)
    emitDenseReferenceArrayRead(
      host,
      array,
      index,
      integerIndex,
      loopIndex !== null,
      storeValue,
      no,
      slow,
      join,
      !scalar
        ? referenceLoad(host, read.array.type)
        : read.element.kind === "bool"
          ? "i8"
          : int32
            ? "i32"
            : "i64",
    );
  else B.br(slow);
  B.startBlock(slow);
  const slowValue = B.newLabel("local.array.slow.value");
  if (scalar) {
    // Holes, present undefined, sparse and noncanonical indices: the
    // runtime state decides presence, then the strict getter reads it.
    // Both only read (the getter runs for a present element, so it does
    // not trap), which lets LLVM keep the array's header loads out of a
    // loop around an inlined read.
    const state = B.tmp(),
      present = B.tmp();
    host.declare(`declare double @scr_arr_state(ptr, double)`);
    B.line(
      `${state} = call double @scr_arr_state(ptr ${array.name}, double ${index.name})${READ_FALLBACK}`,
    );
    B.line(`${present} = fcmp oeq double ${state}, 1.0`);
    B.condBr(present, slowValue, no);
    B.startBlock(slowValue);
    const value = B.tmp(),
      bits = B.tmp();
    if (read.element.kind === "f64") {
      host.declare(`declare double @scr_arr_get_f64(ptr, double)`);
      B.line(
        `${value} = call double @scr_arr_get_f64(ptr ${array.name}, double ${index.name})${READ_FALLBACK}`,
      );
      if (element) B.line(`${bits} = fptosi double ${value} to i32`);
      else B.line(`${bits} = bitcast double ${value} to i64`);
    } else {
      host.declare(`declare zeroext i1 @scr_arr_get_bool(ptr, double)`);
      B.line(
        `${value} = call zeroext i1 @scr_arr_get_bool(ptr ${array.name}, double ${index.name})${READ_FALLBACK}`,
      );
      B.line(`${bits} = zext i1 ${value} to i64`);
    }
    if (element) B.line(`store i32 ${bits}, ptr ${element}`);
    else B.line(`store i64 ${bits}, ptr ${payload}`);
    B.line(`store i32 ${read.presentTag}, ptr ${tag}`);
  } else {
    const value = B.tmp(),
      present = B.tmp();
    host.declare("declare ptr @scr_arr_peek_ref(ptr, double) memory(read)");
    B.line(`${value} = call ptr @scr_arr_peek_ref(ptr ${array.name}, double ${index.name})`);
    B.line(`${present} = icmp ne ptr ${value}, null`);
    B.condBr(present, slowValue, no);
    B.startBlock(slowValue);
    storeValue(value);
  }
  B.br(join);
  B.startBlock(no);
  if (element) B.line(`store i32 0, ptr ${element}`);
  else B.line(`store i64 0, ptr ${payload}`);
  B.line(`store i32 ${read.missingTag}, ptr ${tag}`);
  B.br(join);
  B.startBlock(join);
  if (element) {
    const value = B.tmp(),
      number = B.tmp(),
      bits = B.tmp();
    B.line(`${value} = load i32, ptr ${element}`);
    B.line(`${number} = sitofp i32 ${value} to double`);
    B.line(`${bits} = bitcast double ${number} to i64`);
    B.line(`store i64 ${bits}, ptr ${payload}`);
  }
  B.line(`store ptr ${box}, ptr ${localSlot}`);
  return read.borrow || scalar ? null : { slot: payload, type: read.element };
}
