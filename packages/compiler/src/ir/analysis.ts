import { InternalCompilerError } from "../errors.js";
import {
  DYN_HANDLE_KINDS,
  RUNTIME_STREAM_CLASSES,
  type IrExpr,
  type IrLibFn,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "./ir.js";

/**
 * Recognize the one concat shape whose destination binding can temporarily
 * hand off its ownership to the left operand:
 *
 *     target = target + suffix
 *
 * Both native emitters use this rather than attempting a wider purity or
 * alias analysis.  In particular, fields, nested concat trees, dynamic
 * operations, and a different destination all retain the ordinary borrowed
 * concat lowering.
 */
export function matchStringSelfConcat(targetLocalId: string, value: IrExpr): IrExpr | null {
  if (
    value.kind !== "strConcat" ||
    value.type.kind !== "string" ||
    value.left.kind !== "varRef" ||
    value.left.type.kind !== "string" ||
    value.left.localId !== targetLocalId ||
    value.right.type.kind !== "string"
  ) {
    return null;
  }
  return value.right;
}

/** The class-graph surface needed by backend-independent hierarchy queries. */
export interface IrClassGraphNode {
  readonly def: { readonly name: string };
  readonly base: IrClassGraphNode | null;
  readonly children: readonly IrClassGraphNode[];
}

/** Short human description of a dynCheck target for error messages. */
export function dynDesc(
  t: IrType,
  recordsById: ReadonlyMap<string, IrRecordShape>,
  unionsById: ReadonlyMap<string, IrUnionDef>,
): string {
  switch (t.kind) {
    case "f64": return "number";
    case "bigint": return "bigint";
    case "string": return "string";
    case "bool": return "boolean";
    case "record": return recordsById.get(t.shapeId)?.tuple ? "array" : "object";
    case "array": return "array";
    case "nullT": return "null";
    case "undefinedT": return "undefined";
    case "dyn": return "unknown";
    case "bytes": return "Uint8Array";
    case "object": return t.className.replace(/^%/, "");
    case "union": {
      const def = unionsById.get(t.unionId);
      if (!def) throw new InternalCompilerError(`IR analysis bug: dynDesc of unknown union ${t.unionId}`);
      return def.arms.map((arm) => dynDesc(arm, recordsById, unionsById)).join(" | ");
    }
    case "func": return "function";
    case "map": return "Map";
    case "set": return "Set";
    default: {
      const handle = DYN_HANDLE_KINDS.get(t.kind);
      if (handle) return handle.cls;
      throw new InternalCompilerError(`IR analysis bug: dynDesc of non-JSON type ${t.kind}`);
    }
  }
}

// These scalar lowerings borrow no references and cannot invoke user code,
// suspend, or release an owner. Keep this explicit: array folds and future
// Math operations must not inherit the guarantee from their name alone.
const BORROW_SAFE_MATH = new Set<IrLibFn>([
  "math.floor", "math.ceil", "math.trunc", "math.round", "math.abs",
  "math.min", "math.max", "math.sqrt", "math.pow",
  "math.sin", "math.sinh", "math.cos", "math.cosh", "math.tan", "math.tanh",
  "math.asin", "math.asinh", "math.acos", "math.acosh", "math.atan", "math.atanh",
  "math.atan2", "math.cbrt", "math.clz32", "math.sign", "math.exp", "math.expm1",
  "math.fround", "math.log", "math.log1p", "math.log2", "math.log10", "math.imul",
]);

/** Whether an operand preserves a direct receiver binding until its last
 * borrowed use. No user calls or suspension may intervene. This does not
 * prove the operation itself safe to borrow; callers must establish that
 * separately. Deliberately conservative: uncertain shapes are false. */
export function isStableReceiverOperand(e: IrExpr, receiverLocalId: string): boolean {
  switch (e.kind) {
    case "numLit":
    case "boolLit":
    case "varRef":
    case "incDec":
      return true;
    case "assignExpr":
      return e.localId !== receiverLocalId && isStableReceiverOperand(e.value, receiverLocalId);
    case "bin":
    case "logical":
      return isStableReceiverOperand(e.left, receiverLocalId) &&
        isStableReceiverOperand(e.right, receiverLocalId);
    case "unary":
    case "toBool":
      return isStableReceiverOperand(e.operand, receiverLocalId);
    case "ternary":
      return isStableReceiverOperand(e.cond, receiverLocalId) &&
        isStableReceiverOperand(e.then, receiverLocalId) &&
        isStableReceiverOperand(e.else_, receiverLocalId);
    case "bytesIntrinsic":
      return (e.method === "get" || e.method === "length" || e.method === "byteLength") &&
        e.receiver.kind === "varRef" &&
        e.args.every((arg) => isStableReceiverOperand(arg, receiverLocalId));
    case "libCall":
      return BORROW_SAFE_MATH.has(e.fn) && e.type.kind === "f64" &&
        e.args.every((arg) => arg.type.kind === "f64" && isStableReceiverOperand(arg, receiverLocalId));
    default:
      return false;
  }
}

/** The undefined arm's tag of a union type, or -1. */
export function undefinedArmTag(
  t: IrType,
  unionsById: ReadonlyMap<string, IrUnionDef>,
): number {
  if (t.kind !== "union") return -1;
  return unionsById.get(t.unionId)?.arms.findIndex((arm) => arm.kind === "undefinedT") ?? -1;
}

/** True when a statement list ends in a control-flow jump. */
export function endsWithJump(stmts: readonly IrStmt[]): boolean {
  const last = stmts[stmts.length - 1]?.kind;
  return last === "return" || last === "break" || last === "continue" ||
    last === "throw" || last === "rethrow" || last === "runtimeFence";
}

/** True when class-value construction can enter a throwing constructor in
 * the static class's descendant subtree. */
export function newValueMayThrow(
  className: string,
  classes: ReadonlyMap<string, IrClassGraphNode>,
  mayThrow: ReadonlySet<string>,
): boolean {
  const meta = classes.get(className);
  if (!meta) throw new InternalCompilerError(`IR analysis bug: newValue on unknown class ${className}`);
  const any = (node: IrClassGraphNode): boolean =>
    mayThrow.has(`%${node.def.name}.constructor`) || node.children.some(any);
  return any(meta);
}

/** Types transported as live typed references across Web-stream dyn edges. */
export function streamTypedRefEligible(t: IrType): boolean {
  return t.kind === "record" || t.kind === "array" || t.kind === "bytes";
}

/** True when a class descends from a runtime stream class. */
export function streamRooted(meta: IrClassGraphNode): boolean {
  for (let current = meta.base; current; current = current.base) {
    if (RUNTIME_STREAM_CLASSES.has(current.def.name)) return true;
  }
  return false;
}
