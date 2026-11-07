/* Values that would enter a class of record types as a copy. */
import * as ts from "../../ts7/adapter.js";
import type { IrType } from "../../../ir/ir.js";
import { literalValues } from "../../literal-values.js";
import type { Lowerer } from "../lowerer.js";

/** The types of a class (union-classes.ts) map to the class's record, so a
 * value of one of them is the object the union holds. A record whose type
 * is none of them can still have the layout one of them has on its own: an
 * inferred literal type (`const e = { type: "retry" as const, source:
 * "a" as const }`) or a type written out a second time. Such a value was
 * the union's arm before the class existed; now it would be converted
 * into the class's record, and a conversion is a copy: writes through the
 * union value would miss the binding and `===` would be false.
 *
 * A literal written at the slot has no other name, so its copy cannot be
 * told from it and it converts as before. So does a value whose own
 * discriminant names the arm that has its layout (a member of the union
 * that is in no class, `{ type: "end"; id: string }` beside the class of
 * `{ type: "retry"; id: string }`): it enters that arm as the object it is.
 * Any other expression is refused here, by name, and the fix is in the
 * message: give the value its type. */
export function refuseClassRecordCopy(
  lowerer: Lowerer,
  node: ts.Node,
  source: IrType,
  expected: IrType,
): void {
  const classes = lowerer.typeCtx.unionClassRecords;
  if (classes === undefined || classes.size === 0 || source.kind !== "record") return;
  const candidates =
    expected.kind === "record"
      ? [expected]
      : expected.kind === "union"
        ? (lowerer.unions.get(expected.unionId)?.arms ?? [])
        : [];
  const target = candidates.find(
    (arm) =>
      arm.kind === "record" &&
      arm.shapeId !== source.shapeId &&
      classes.get(arm.shapeId)?.has(source.shapeId) === true,
  );
  if (target === undefined) return;
  if (expected.kind === "union" && discriminantNamesOwnArm(lowerer, node, source, expected.unionId))
    return;
  let value: ts.Node = node;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertion(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value)
  )
    value = value.expression;
  if (ts.isObjectLiteralExpression(value)) return;
  lowerer.unsupported(
    "SC1090",
    node,
    `a '${lowerer.fmt(source)}' value where '${lowerer.fmt(expected)}' is expected (the union keeps its members that share one discriminant value as one record, '${lowerer.fmt(target)}', and this value's type is not one of those members: it would be copied into that record, and the copy would not be the object this expression names)`,
    "declare the value with the union's type, or with the type of the union member it is, so that it is built as that record",
  );
}

/** Whether the literals the checker gives `node`'s discriminant member all
 * belong to the arm of the union that has `source`'s layout: the conversion
 * then tags the value as that arm and copies nothing. */
function discriminantNamesOwnArm(
  lowerer: Lowerer,
  node: ts.Node,
  source: IrType & { kind: "record" },
  unionId: string,
): boolean {
  const def = lowerer.unions.get(unionId);
  if (def?.discriminant === undefined || lowerer.armTag(unionId, source) < 0) return false;
  const property = lowerer.checker.getPropertyOfType(lowerer.typeOf(node), def.discriminant.field);
  if (
    property === undefined ||
    (property.flags &
      (ts.SymbolFlags.Optional | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !==
      0
  )
    return false;
  const values = literalValues(lowerer.checker.getTypeOfSymbol(property));
  const arm = values === null ? null : lowerer.literalUnionArm(unionId, values);
  return arm !== null && arm.shapeId === source.shapeId;
}
