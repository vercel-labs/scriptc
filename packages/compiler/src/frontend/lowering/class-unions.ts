import { BOOL, type IrExpr, type IrStmt, type IrType } from "../../ir/ir.js";
import { nodeThrowExpr, varRef } from "../../ir/build.js";
import { checkedClassAssertion } from "./class-assertions.js";
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

/** Recover a class refinement from optional storage without treating the
 * checker's non-optional array element type as proof of presence. Only a
 * stricter class view qualifies; the stored tag and class are validated. */
export function narrowStoredClassValue(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType,
): IrExpr | null {
  if (value.type.kind !== "union") return null;
  const arms = lowerer.unions.get(value.type.unionId)?.arms;
  if (!arms) return null;
  if (target.kind === "object") {
    if (
      !arms.some(
        (arm) =>
          arm.kind === "object" &&
          arm.className !== target.className &&
          lowerer.isSubclassOf(target.className, arm.className),
      )
    )
      return null;
    return checkedClassAssertion(lowerer, value, target, value.loc);
  }
  if (target.kind !== "union") return null;
  const present = lowerer.stripUndefinedArm(value.type);
  if (present.kind !== "object") return null;
  const targetArms = lowerer.unions.get(target.unionId)?.arms;
  if (
    !targetArms?.length ||
    !targetArms.every(
      (arm) => arm.kind === "object" && lowerer.isSubclassOf(arm.className, present.className),
    )
  )
    return null;
  const extract = lowerer.narrowedArmHelper(value.type.unionId, present, value.loc);
  if (!extract) return null;
  return narrowClassUnion(
    lowerer,
    {
      kind: "call",
      callee: extract,
      args: [value],
      type: present,
      loc: value.loc,
    },
    target,
  );
}

/** An erased generic instanceof test identifies a family, not a concrete
 * field layout. Recover a demanded instantiation only after checking its
 * runtime membership; incompatible specializations cannot share payloads. */
export function narrowGenericClassValue(
  lowerer: Lowerer,
  value: IrExpr,
  expected: IrType,
): IrExpr | null {
  if (value.type.kind !== "object") return null;
  const family = lowerer.classes.get(value.type.className);
  if (!family?.generic || !lowerer.inHierarchy(family)) return null;
  const arms = expected.kind === "union" ? lowerer.unions.get(expected.unionId)?.arms : [expected];
  const candidates = arms?.filter(
    (arm) =>
      arm.kind === "object" &&
      lowerer.classes.get(arm.className)?.genericInstance?.family === family,
  );
  const target = candidates?.length === 1 ? candidates[0] : undefined;
  return target?.kind === "object"
    ? checkedClassAssertion(lowerer, value, target, value.loc)
    : null;
}
