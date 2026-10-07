import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { F64, type IrExpr, STRING } from "../../../ir/ir.js";
import { lowerOptionalArgument } from "../optional-arguments.js";

const OPERATIONS = [
  "load",
  "store",
  "exchange",
  "compareExchange",
  "add",
  "sub",
  "and",
  "or",
  "xor",
];

/** Familiar integer Atomics over fixed typed storage. Wait queues are keyed
 * by backing allocation and byte offset, so distinct views address one queue. */
export function lowerAtomicsCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(access, "Atomics");
  if (member === null) return null;
  const loc = locOf(call);
  const operation = OPERATIONS.indexOf(member);
  if (operation < 0 && member !== "wait" && member !== "notify") {
    lowerer.noLowering(
      `Atomics.${member}`,
      call,
      "use integer load, store, exchange, compareExchange, add, sub, and, or, xor, wait or notify",
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  const minimum =
    member === "wait"
      ? 3
      : member === "notify" || member === "load"
        ? 2
        : member === "compareExchange"
          ? 4
          : 3;
  const maximum = member === "wait" ? 4 : member === "notify" ? 3 : minimum;
  if (
    call.arguments.length < minimum ||
    call.arguments.length > maximum ||
    call.arguments.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `Atomics.${member} arguments`,
      call,
      `use ${minimum}${maximum > minimum ? `–${maximum}` : ""} arguments`,
    );
  }
  const source = call.arguments[0]!;
  // Generic constraints can remain unions in the checker while this body
  // has a concrete typed-array binding. Validate the actual lowered storage.
  const array = lowerer.lowerExpr(source);
  const type = array.type;
  if (
    type?.kind !== "bytes" ||
    !["i8", "u8", "i16", "u16", "i32", "u32"].includes(type.elem) ||
    ((member === "wait" || member === "notify") && type.elem !== "i32")
  ) {
    lowerer.noLowering(
      `Atomics.${member} over this array`,
      source,
      member === "wait" || member === "notify"
        ? "use an Int32Array"
        : "use an 8-, 16-, or 32-bit integer typed array",
    );
  }
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  const arg = (index: number, fallback: number): IrExpr =>
    call.arguments[index]
      ? lowerOptionalArgument(lowerer, call.arguments[index]!, F64, number(fallback))
      : number(fallback);
  const index = arg(1, 0);
  if (member === "wait")
    return {
      kind: "libCall",
      fn: "atomics.wait",
      args: [array, index, arg(2, 0), arg(3, Infinity)],
      type: STRING,
      loc,
    };
  if (member === "notify")
    return {
      kind: "libCall",
      fn: "atomics.notify",
      args: [array, index, arg(2, Infinity)],
      type: F64,
      loc,
    };
  return {
    kind: "libCall",
    fn: "atomics.op",
    args: [array, index, arg(2, 0), arg(3, 0), number(operation)],
    type: F64,
    loc,
  };
}
