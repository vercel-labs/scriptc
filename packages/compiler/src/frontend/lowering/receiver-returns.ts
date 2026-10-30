/* Methods that return their receiver, called through an untyped value.
 *
 * A JavaScript method that ends every path with `return this` (a fluent
 * setter such as `step(dx, dy) { this.x += dx; return this; }`) boxes its
 * receiver on every call: a lookup of the instance's live capsule, or a new
 * capsule when it has none. A class dispatch helper
 * (`%dyn.class.call.N`) that calls such a method already holds a capsule
 * of the same instance at its exact class: its receiver after
 * normalization. The helper now calls a copy of the method that returns
 * nothing and answers its own receiver, so the call boxes nothing. A
 * direct call whose result nothing reads calls the copy too. Other callers
 * (vtables, method values, calls that use the result) keep the method
 * itself. */
import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { VOID } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

const DISPATCH_PREFIX = "%dyn.class.call.";
const BOX_EXACT_PREFIX = "%dyn.class.boxExact:";

/** The name of a method's copy that returns nothing. */
function receiverCopyName(method: string): string {
  return `%dyn.class.receiver:${method.slice(1)}`;
}

export function returnDispatchReceivers(lowerer: Lowerer, functions: IrFunction[]): void {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const copies = new Map<string, IrFunction | null>();
  const copyOf = (name: string): IrFunction | null => {
    const known = copies.get(name);
    if (known !== undefined) return known;
    const method = byName.get(name);
    const copy = method && returnsReceiver(lowerer, method) ? receiverCopy(method) : null;
    copies.set(name, copy);
    if (copy) functions.push(copy);
    return copy;
  };
  for (const helper of functions) {
    if (!helper.name.startsWith(DISPATCH_PREFIX)) continue;
    const receiver = helper.params[0]?.localId;
    if (receiver === undefined || !normalizedOnly(helper, receiver)) continue;
    for (const stmt of helper.body) {
      if (stmt.kind !== "if" || stmt.then.length !== 1) continue;
      const only = stmt.then[0]!;
      if (only.kind !== "return" || only.value === null || only.value.kind !== "call") continue;
      const call = only.value;
      if (!receiverArgument(call.args[0], receiver)) continue;
      const copy = copyOf(call.callee);
      if (!copy) continue;
      stmt.then = [
        {
          kind: "exprStmt",
          expr: { ...call, callee: copy.name, type: VOID },
          loc: only.loc,
        },
        { kind: "return", value: varRef(receiver, only.value.type, only.loc), loc: only.loc },
      ];
    }
  }
  // A direct call whose result nothing reads (`builder.set(1);` in typed
  // code) needs no capsule at all.
  for (const fn of [...functions]) {
    everyStmtList(fn.body, {
      stmt: (s) => {
        if (s.kind === "exprStmt" && s.expr.kind === "call") {
          const copy = copyOf(s.expr.callee);
          if (copy) s.expr = { ...s.expr, callee: copy.name, type: VOID };
        }
        return true;
      },
      expr: () => true,
    });
  }
}

/** The helper's receiver is assigned only by its normalization, so it is
 * the capsule of the instance's own class wherever a branch reads it. */
function normalizedOnly(helper: IrFunction, receiver: string): boolean {
  return everyStmtList(helper.body, {
    stmt: (s) =>
      !(
        (s.kind === "assign" || s.kind === "forOf") &&
        s.localId === receiver &&
        !(
          s.kind === "assign" &&
          s.value.kind === "call" &&
          s.value.callee === "%dyn.class.normalize"
        )
      ),
    expr: (e) => !((e.kind === "assignExpr" || e.kind === "incDec") && e.localId === receiver),
  });
}

/** `dynCheck(receiver)`, possibly upcast to the method's class. */
function receiverArgument(arg: IrExpr | undefined, receiver: string): boolean {
  if (arg?.kind === "upcast") arg = arg.value;
  return arg?.kind === "dynCheck" && arg.value.kind === "varRef" && arg.value.localId === receiver;
}

/** Whether every path of a synchronous method returns `this` boxed at its
 * exact class. */
function returnsReceiver(lowerer: Lowerer, fn: IrFunction): boolean {
  if (fn.async !== undefined || fn.generator !== undefined) return false;
  if (fn.captures?.length || fn.classCaptures?.length) return false;
  if (fn.returnType.kind !== "dyn") return false;
  const self = fn.params[0];
  if (self?.type.kind !== "object" || self.name !== "this") return false;
  const last = fn.body[fn.body.length - 1];
  if (last?.kind !== "return") return false;
  const isSelf = (value: IrExpr | null): boolean => {
    if (value === null) return false;
    if (value.kind === "call" && value.callee.startsWith(BOX_EXACT_PREFIX))
      return thisRef(value.args[0], self.localId);
    // Without exact boxing the capsule names the static class, which is
    // the instance's own class only when nothing extends it.
    if (value.kind === "dynFrom" && value.liveRef === undefined && value.fnName === undefined) {
      const className = self.type.kind === "object" ? self.type.className : "";
      return (
        thisRef(value.value, self.localId) &&
        (lowerer.classes.get(className)?.subclasses.length ?? 1) === 0
      );
    }
    return false;
  };
  return everyStmtList(fn.body, {
    stmt: (s) => s.kind !== "return" || isSelf(s.value),
    expr: () => true,
  });
}

function thisRef(value: IrExpr | undefined, thisId: string): boolean {
  return value?.kind === "varRef" && value.localId === thisId;
}

/** A copy of `method` whose returns return nothing. */
function receiverCopy(method: IrFunction): IrFunction {
  const copy = structuredClone(method);
  copy.name = receiverCopyName(method.name);
  copy.returnType = VOID;
  copy.body = transformStmtList(copy.body, {
    stmt: (s): IrStmt => (s.kind === "return" ? { ...s, value: null } : s),
    expr: (e) => e,
  });
  return copy;
}
