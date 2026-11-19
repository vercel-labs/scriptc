/** A class-typed value crossing to an island carries the class it has at run time, not the one
 * its static type names: a class test per class below the static type (nested, deepest test
 * outermost) picks it, and the static class is the fallback. The capsule then answers the exact
 * class's method table, its `in` names and its fields — a canvas obtained as an HTMLElement
 * answers getContext, width and height. The tests are native class tests (a few ns for a whole
 * DOM hierarchy), run once per crossing. */
import { BOOL, DYN, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

export function exactClassCrossing(
  lowerer: Lowerer,
  value: IrExpr,
  loc: SrcLoc,
  convert: (value: IrExpr, className: string) => IrExpr = (v) => lowerer.coerceToExpected(v, DYN),
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const info = lowerer.classes.get(value.type.className);
  if (info === undefined || info.def.runtime) return null;
  const below: { name: string; depth: number }[] = [];
  const seen = new Set<string>([info.def.name]);
  const walk = (current: ClassInfo, depth: number): void => {
    for (const sub of current.subclasses) {
      // A class nothing constructs has no instances to test for, and its abstract members have
      // no values a table could hold: no branch. Its own descendants are still walked.
      if (!seen.has(sub.def.name) && !sub.generic && !sub.localClass && !sub.def.runtime) {
        if (!sub.def.abstract) below.push({ name: sub.def.name, depth });
      }
      seen.add(sub.def.name);
      walk(sub, depth + 1);
    }
  };
  walk(info, 1);
  if (below.length === 0) return null;
  const local = lowerer.declareHiddenLocal("%crossClass", value.type);
  const subject = varRef(local.id, value.type, loc);
  const branch = (className: string): IrExpr =>
    convert(
      className === info.def.name
        ? subject
        : { kind: "downcast", value: subject, type: { kind: "object", className }, loc },
      className,
    );
  let chain: IrExpr = branch(info.def.name);
  // Shallowest first, so a deeper class's test wraps the chain and wins.
  below.sort((a, b) => a.depth - b.depth);
  for (const { name } of below) {
    chain = {
      kind: "ternary",
      cond: { kind: "instanceOf", value: subject, className: name, type: BOOL, loc },
      then: branch(name),
      else_: chain,
      type: DYN,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: chain,
    type: DYN,
    loc,
  };
}
