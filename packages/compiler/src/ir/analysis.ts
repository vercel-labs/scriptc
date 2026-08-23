import { InternalCompilerError } from "../errors.js";
import {
  DYN_HANDLE_KINDS,
  RUNTIME_STREAM_CLASSES,
  type IrExpr,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type IrUnionDef,
} from "./nodes.js";

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

/** Whether evaluating an index/value expression can overwrite a bytes
 * receiver binding. Deliberately conservative: uncertain shapes are false. */
export function isStableBytesOperand(e: IrExpr, receiverLocalId: string): boolean {
  switch (e.kind) {
    case "numLit":
    case "boolLit":
    case "varRef":
    case "incDec":
      return true;
    case "assignExpr":
      return e.localId !== receiverLocalId && isStableBytesOperand(e.value, receiverLocalId);
    case "bin":
    case "logical":
      return isStableBytesOperand(e.left, receiverLocalId) &&
        isStableBytesOperand(e.right, receiverLocalId);
    case "unary":
    case "toBool":
      return isStableBytesOperand(e.operand, receiverLocalId);
    case "ternary":
      return isStableBytesOperand(e.cond, receiverLocalId) &&
        isStableBytesOperand(e.then, receiverLocalId) &&
        isStableBytesOperand(e.else_, receiverLocalId);
    case "bytesIntrinsic":
      return (e.method === "get" || e.method === "length" || e.method === "byteLength") &&
        e.receiver.kind === "varRef" &&
        e.args.every((arg) => isStableBytesOperand(arg, receiverLocalId));
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
