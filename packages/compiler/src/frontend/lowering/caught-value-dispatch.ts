import { varRef } from "../../ir/build.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { everyStmtList, transformStmtList } from "../../ir/traverse.js";
import { classInstanceOf } from "./class-dynamic-dispatch.js";
import type { DispatchSites } from "./dispatch-sites.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

/** Exception snapshots retain native objects. Recover their known layouts
 * before crossing into unknown, using the same live capsules as ordinary
 * class values. The reachable throw census grows with the lowering worklist. */
export class CaughtValueDispatch {
  private readonly thrownClasses = new Set<string>();
  private readonly convertedClasses = new Set<string>();
  private helper: IrFunction | null = null;
  /** The dynamic-payload helpers of class tests and extractions, by kind
   * and class (dynamicPayloads). */
  private readonly payloadHelpers = new Map<string, IrFunction>();
  private readonly payloadHelperFns = new Set<IrFunction>();

  process(lowerer: Lowerer, functions: readonly IrFunction[], sites: DispatchSites): boolean {
    const consumers: IrFunction[] = [];
    for (const fn of functions) {
      if (fn === this.helper) continue;
      const found = sites.of(fn);
      for (const className of found.thrown) {
        const info = lowerer.classes.get(className);
        if (info) this.thrownClasses.add(info.def.name);
      }
      if (found.caughtValues) consumers.push(fn);
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
      lowerer.shareHelper(this.helper);
      changed = true;
    }
    const helper = this.helper;
    let added = false;
    for (const className of this.thrownClasses) {
      if (this.convertedClasses.has(className)) continue;
      this.convertedClasses.add(className);
      added = true;
    }
    if (added) {
      // A subclass is tested before its ancestors, and classes of one depth
      // by name, so the tests do not depend on the order the census met them.
      const depth = (className: string): number => {
        let count = 0;
        for (let info = lowerer.classes.get(className)?.base; info; info = info.base) count++;
        return count;
      };
      const ordered = [...this.convertedClasses].sort(
        (left, right) => depth(right) - depth(left) || (left < right ? -1 : left > right ? 1 : 0),
      );
      const loc = helper.loc;
      const value = varRef("caught", CAUGHT, loc);
      helper.body = [
        ...ordered.map((className): IrStmt => {
          const type: IrType = { kind: "object", className };
          return {
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
          };
        }),
        helper.body[helper.body.length - 1]!,
      ];
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

  /** A thrown unknown or union value, and the runtime's own dynamic throws,
   * reach a catch binding as a dynamic payload. When an instance of class C
   * can be such a payload (C or a subclass of C crosses into unknown, the
   * `boxed` classes), `e instanceof C`, the reads it narrows and `e as C` in
   * `sites` also answer through the dynamic class test, as standalone classes
   * already do. Programs that never box C keep the native payload test. */
  dynamicPayloads(
    lowerer: Lowerer,
    sites: ReadonlySet<IrFunction>,
    boxed: ReadonlySet<string>,
  ): boolean {
    if (boxed.size === 0 || sites.size === 0) return false;
    const reached = new Map<string, ClassInfo | null>();
    const reachable = (className: string | undefined): ClassInfo | null => {
      if (className === undefined) return null;
      let info = reached.get(className);
      if (info === undefined) {
        const found = lowerer.classes.get(className);
        info =
          found &&
          lowerer.inHierarchy(found) &&
          [...boxed].some((name) => name === className || lowerer.isSubclassOf(name, className))
            ? found
            : null;
        reached.set(className, info);
      }
      return info;
    };
    let changed = false;
    const qualifies = (expr: IrExpr): boolean =>
      expr.kind === "caughtTest"
        ? expr.test === "instanceof" && reachable(expr.className) !== null
        : (expr.kind === "caughtNarrow" || expr.kind === "caughtCheck") &&
          expr.type.kind === "object" &&
          reachable(expr.type.className) !== null;
    for (const fn of sites) {
      // The conversions themselves test the native payload.
      if (fn === this.helper || this.payloadHelperFns.has(fn)) continue;
      const found = !everyStmtList(fn.body, { stmt: () => true, expr: (expr) => !qualifies(expr) });
      if (!found) continue;
      fn.body = transformStmtList(fn.body, {
        stmt: (stmt) => stmt,
        expr: (expr) => {
          if (expr.kind === "caughtTest" && expr.test === "instanceof") {
            const info = reachable(expr.className);
            if (!info) return expr;
            changed = true;
            const call: IrExpr = {
              kind: "call",
              callee: this.payloadHelper(lowerer, "instanceof", info, expr.loc).name,
              args: [expr.value],
              type: BOOL,
              loc: expr.loc,
            };
            return expr.negated
              ? { kind: "unary", op: "!", operand: call, type: BOOL, loc: expr.loc }
              : call;
          }
          if (
            (expr.kind === "caughtNarrow" || expr.kind === "caughtCheck") &&
            expr.type.kind === "object"
          ) {
            const info = reachable(expr.type.className);
            if (!info) return expr;
            changed = true;
            const kind = expr.kind === "caughtNarrow" ? "narrow" : "check";
            return {
              kind: "call",
              callee: this.payloadHelper(lowerer, kind, info, expr.loc).name,
              args: [expr.value],
              type: expr.type,
              loc: expr.loc,
            };
          }
          return expr;
        },
      });
    }
    return changed;
  }

  /** `%caught.instanceof:C`, `%caught.narrow:C` and `%caught.check:C`: the
   * native payload test or extraction, and otherwise a value thrown as
   * unknown tested against C and checked into C. A check of a payload that
   * is not a C keeps caughtCheck's TypeError. */
  private payloadHelper(
    lowerer: Lowerer,
    kind: "instanceof" | "narrow" | "check",
    info: ClassInfo,
    loc: SrcLoc,
  ): IrFunction {
    const className = info.def.name;
    const name = `%caught.${kind}:${className}`;
    const existing = this.payloadHelpers.get(name);
    if (existing) return existing;
    const caught = (): IrExpr => varRef("caught", CAUGHT, loc);
    const dynamic = (): IrExpr => ({ kind: "caughtToDyn", value: caught(), type: DYN, loc });
    const native: IrExpr = {
      kind: "caughtTest",
      value: caught(),
      test: "instanceof",
      className,
      type: BOOL,
      loc,
    };
    // Only a value thrown as unknown can hold an instance besides a native
    // payload, which the native test answers exactly.
    const dynamicInstance = (): IrExpr => ({
      kind: "logical",
      op: "&&",
      left: { kind: "caughtTest", value: caught(), test: "dynamic", type: BOOL, loc },
      right: classInstanceOf(lowerer, dynamic(), info, loc),
      type: BOOL,
      loc,
    });
    const type: IrType = { kind: "object", className };
    const returnType = kind === "instanceof" ? BOOL : type;
    let value: IrExpr;
    if (kind === "instanceof") {
      value = {
        kind: "ternary",
        cond: native,
        then: { kind: "boolLit", value: true, type: BOOL, loc },
        else_: dynamicInstance(),
        type: BOOL,
        loc,
      };
    } else if (kind === "narrow") {
      value = {
        kind: "ternary",
        cond: native,
        then: { kind: "caughtNarrow", value: caught(), type, loc },
        else_: lowerer.coerceToExpected(dynamic(), type),
        type,
        loc,
      };
    } else {
      value = {
        kind: "ternary",
        cond: dynamicInstance(),
        then: lowerer.coerceToExpected(dynamic(), type),
        else_: { kind: "caughtCheck", value: caught(), className, type, loc },
        type,
        loc,
      };
    }
    const helper: IrFunction = {
      name,
      params: [{ localId: "caught", name: "caught", type: CAUGHT }],
      locals: [{ id: "caught", name: "caught", type: CAUGHT, mutable: false }],
      returnType,
      body: [{ kind: "return", value, loc }],
      loc,
    };
    this.payloadHelpers.set(name, helper);
    this.payloadHelperFns.add(helper);
    lowerer.liftedFns.push(helper);
    return helper;
  }
}
