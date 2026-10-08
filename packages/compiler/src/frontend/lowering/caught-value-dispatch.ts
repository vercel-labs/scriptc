import { varRef } from "../../ir/build.js";
import { BOOL, CAUGHT, DYN, type IrFunction, type IrType } from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

/** Exception snapshots retain native objects. Recover their known layouts
 * before crossing into unknown, using the same live capsules as ordinary
 * class values. The reachable throw census grows with the lowering worklist. */
export class CaughtValueDispatch {
  private readonly thrownClasses = new Set<string>();
  private readonly convertedClasses = new Set<string>();
  private helper: IrFunction | null = null;

  process(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
    const consumers: IrFunction[] = [];
    for (const fn of functions) {
      if (fn === this.helper) continue;
      let consumes = false;
      everyStmtList(fn.body, {
        stmt: (stmt) => {
          if (stmt.kind === "throw" && stmt.value.type.kind === "object") {
            const info = lowerer.classes.get(stmt.value.type.className);
            if (info) this.thrownClasses.add(info.def.name);
          }
          return true;
        },
        expr: (expr) => {
          if (expr.kind === "caughtToDyn") consumes = true;
          return true;
        },
      });
      if (consumes) consumers.push(fn);
    }
    if (!this.helper && consumers.length === 0) return false;
    let changed = false;
    if (!this.helper) {
      const loc = consumers[0]!.loc;
      const value = varRef("caught", CAUGHT, loc);
      this.helper = {
        name: "%caught.dynamicValue",
        params: [{ localId: "caught", name: "caught", type: CAUGHT }],
        locals: [{ id: "caught", name: "caught", type: CAUGHT, mutable: false }],
        returnType: DYN,
        body: [{ kind: "return", value: { kind: "caughtToDyn", value, type: DYN, loc }, loc }],
        loc,
      };
      lowerer.liftedFns.push(this.helper);
      changed = true;
    }
    const helper = this.helper;
    for (const className of this.thrownClasses) {
      if (this.convertedClasses.has(className)) continue;
      this.convertedClasses.add(className);
      const loc = helper.loc;
      const value = varRef("caught", CAUGHT, loc);
      const type: IrType = { kind: "object", className };
      helper.body.unshift({
        kind: "if",
        cond: { kind: "caughtTest", value, test: "instanceof", className, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: lowerer.coerceToExpected({ kind: "caughtNarrow", value, type, loc }, DYN),
            loc,
          },
        ],
        else_: null,
        loc,
      });
      changed = true;
    }
    for (const fn of consumers) {
      fn.body = transformStmtList(fn.body, {
        stmt: (stmt) => stmt,
        expr: (expr) =>
          expr.kind === "caughtToDyn"
            ? { kind: "call", callee: helper.name, args: [expr.value], type: DYN, loc: expr.loc }
            : expr,
      });
      changed = true;
    }
    return changed;
  }
}
