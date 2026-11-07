import * as ts from "../ts7/adapter.js";
import { canBoxFuncIntoDyn, DYN, funcOf, type IrExpr, type IrType, VOID } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

interface CallbackArgOptions {
  /** Event payload tuple for checked-dynamic callback adaptation. */
  dynTuple?: readonly IrType[];
  /** The dgram precedent: a raw dyn value may fill a zero-arg slot. */
  dynZero?: boolean;
  /** Reject non-void callbacks instead of adapting their result away. */
  rejectValueReturn?: boolean;
  adapt?: (cb: IrExpr) => IrExpr;
}

/** Shared listener/callback shape validation for the Node spoke modules.
 * `paramOk` is asked about every declared parameter, by position: the
 * runtime calls the closure with the event's native payload, so a
 * parameter of another type would read that payload as something it is
 * not. A callback whose only mismatched parameters are dynamic (`unknown`,
 * `any`, an untyped JavaScript parameter) crosses the checked-dynamic
 * boundary instead when the event's payload tuple is known. */
export function lowerCallbackArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  maxParams: number,
  paramOk: (param: IrType, index: number) => boolean,
  paramHint: string,
  options: CallbackArgOptions = {},
): { cb: IrExpr; nparams: number } {
  let cb = lowerer.lowerExpr(node);
  if (cb.type.kind === "dyn" && options.dynTuple !== undefined) {
    const toT = funcOf([...options.dynTuple], VOID);
    return {
      cb: { kind: "dynCheck", value: cb, type: toT, loc: locOf(node) },
      nparams: options.dynTuple.length,
    };
  }
  if (
    options.dynTuple !== undefined &&
    cb.type.kind === "func" &&
    (cb.type.rest === true ||
      (cb.type.params.length > 0 && cb.type.params.some((param, i) => !paramOk(param, i)))) &&
    cb.type.params.every((param, i) => param.kind === "dyn" || paramOk(param, i)) &&
    canBoxFuncIntoDyn(
      cb.type,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    const boxed: IrExpr = { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) };
    const toT = funcOf([...options.dynTuple], VOID);
    return {
      cb: { kind: "dynCheck", value: boxed, type: toT, loc: locOf(node) },
      nparams: options.dynTuple.length,
    };
  }
  if (cb.type.kind === "dyn" && options.dynZero && maxParams === 0) {
    cb = { kind: "dynCheck", value: cb, type: funcOf([], VOID), loc: locOf(node) };
  }
  // A function or undefined: an optional callback read from storage that
  // can hold undefined (a binding code can read before its first store keeps
  // the stored value where the library's parameter admits undefined).
  const arms = cb.type.kind === "union" ? lowerer.unions.get(cb.type.unionId)?.arms : undefined;
  if (
    arms?.length === 2 &&
    arms.some((arm) => arm.kind === "func") &&
    arms.some((arm) => arm.kind === "undefinedT")
  ) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${what} that may be undefined (pass a function: test the value first, or wrap it in an arrow function)`,
    );
  }
  if (cb.type.kind !== "func" || cb.type.params.length > maxParams) {
    lowerer.unsupported(
      "SC1090",
      node,
      `${what} with more than ${maxParams} parameter${maxParams === 1 ? "" : "s"} (${paramHint})`,
    );
  }
  if (options.rejectValueReturn && cb.type.ret.kind !== "void") {
    lowerer.unsupported(
      "SC1090",
      node,
      "listeners returning a value (make the callback body a block, or return nothing)",
    );
  }
  const params = cb.type.params;
  for (let i = 0; i < params.length; i++) {
    if (!paramOk(params[i]!, i)) {
      lowerer.unsupported(
        "SC1090",
        node,
        `${what} whose parameter is not supported (${paramHint})`,
      );
    }
  }
  const adapted = options.adapt?.(cb) ?? cb;
  return { cb: adapted, nparams: cb.type.params.length };
}
