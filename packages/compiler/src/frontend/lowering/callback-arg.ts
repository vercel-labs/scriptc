import * as ts from "../ts7/adapter.js";
import { canBoxFuncIntoDyn, DYN, funcOf, type IrExpr, type IrType, VOID } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

interface CallbackArgOptions {
  /** Event payload tuple for checked-dynamic callback adaptation. */
  dynTuple?: readonly IrType[];
  /** The dgram precedent: a raw dyn value may fill a zero-arg slot. */
  dynZero?: boolean;
  /** Validate every declared parameter (dgram); otherwise just the first. */
  checkAllParams?: boolean;
  /** Reject non-void callbacks instead of adapting their result away. */
  rejectValueReturn?: boolean;
  adapt?: (cb: IrExpr) => IrExpr;
}

/** Shared listener/callback shape validation for the Node spoke modules. */
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
    cb.type.params.every((param) => param.kind === "dyn") &&
    canBoxFuncIntoDyn(cb.type, (id) => lowerer.shapes.get(id), (id) => lowerer.unions.get(id))
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
  const params = options.checkAllParams ? cb.type.params : cb.type.params.slice(0, 1);
  for (let i = 0; i < params.length; i++) {
    if (!paramOk(params[i]!, i)) {
      lowerer.unsupported("SC1090", node, `${what} whose parameter is not supported (${paramHint})`);
    }
  }
  const adapted = options.adapt?.(cb) ?? cb;
  return { cb: adapted, nparams: cb.type.params.length };
}
