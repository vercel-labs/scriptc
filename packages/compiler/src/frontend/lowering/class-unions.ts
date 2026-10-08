import { BOOL, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { nodeThrowExpr, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";

/** A base-class slot stays one pointer after a guard selects several
 * subclasses. Recover the tagged view from runtime membership without
 * copying the object or guessing which of the remaining layouts it has. */
export function narrowClassUnion(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType & { kind: "union" },
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const source = value.type;
  const arms = lowerer.unions.get(target.unionId)?.arms;
  if (
    !arms?.length ||
    !arms.every(
      (arm) => arm.kind === "object" && lowerer.isSubclassOf(arm.className, source.className),
    )
  )
    return null;
  const loc = value.loc;
  const key = `classUnion:${source.className}:${target.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = `%class.union.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, helper);
    const input = varRef("value.0", source, loc);
    // Rank by ancestry before sorting: returning zero for unrelated pairs
    // alone would not reliably put a descendant before a nonadjacent ancestor.
    const ordered = arms
      .map((arm, tag) => ({
        arm,
        tag,
        ancestors: arms.filter(
          (other) =>
            arm.kind === "object" &&
            other.kind === "object" &&
            lowerer.isSubclassOf(arm.className, other.className),
        ).length,
      }))
      .sort((a, b) => b.ancestors - a.ancestors);
    const body: IrStmt[] = [];
    for (const { arm, tag } of ordered) {
      if (arm.kind !== "object") continue;
      body.push({
        kind: "if",
        cond: { kind: "instanceOf", value: input, className: arm.className, type: BOOL, loc },
        then: [
          {
            kind: "return",
            value: {
              kind: "unionWrap",
              unionId: target.unionId,
              tag,
              value: { kind: "downcast", value: input, type: arm, loc },
              type: target,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    }
    body.push({
      kind: "return",
      value: nodeThrowExpr(1, "", "Class value does not match the narrowed union", target, loc),
      loc,
    });
    lowerer.liftedFns.push({
      name: helper,
      params: [{ localId: "value.0", name: "value", type: source }],
      locals: [{ id: "value.0", name: "value", type: source, mutable: false }],
      returnType: target,
      body,
      loc,
    });
  }
  return { kind: "call", callee: helper, args: [value], type: target, loc };
}
