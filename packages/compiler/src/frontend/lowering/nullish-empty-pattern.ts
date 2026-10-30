import { BOOL, type IrExpr, type IrType, isUnitType, sortArms } from "../../ir/ir.js";
import { isJsSourceFile, locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

function stripParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/** `const { a, ...rest } = options ?? {}` (also `|| {}`) where the options
 * record has a member that cannot be absent. The pattern destructures
 * either the record or an empty object, which has no own keys, so the
 * source lowers to a union of the record and the empty record: the union
 * pattern lowering reads each key from the arm that holds it and answers
 * undefined from the empty arm, and a rest element packs the record's
 * remaining fields or nothing. The options operand is evaluated once.
 *
 * Null (the caller keeps its current lowering) for JavaScript files, other
 * initializer forms, an operand the checker does not type as one record
 * plus nullish arms, and a record whose every field may be absent: the
 * existing lowering already builds the empty object as that record with
 * every key absent. */
export function nullishEmptyPatternSource(
  lowerer: Lowerer,
  pattern: ts.BindingName,
  initializer: ts.Expression,
): IrExpr | null {
  if (!ts.isObjectBindingPattern(pattern)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(initializer))) return null;
  const init = stripParens(initializer);
  if (
    !ts.isBinaryExpression(init) ||
    (init.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
      init.operatorToken.kind !== ts.SyntaxKind.BarBarToken)
  )
    return null;
  const right = stripParens(init.right);
  if (!ts.isObjectLiteralExpression(right) || right.properties.nodes.length !== 0) return null;
  const loc = locOf(init);
  // Decide from the checker's view of the operand before lowering it once.
  const declared = lowerer.mapTypeOf(lowerer.typeOf(init.left));
  if (declared?.kind !== "union") return null;
  const declaredArms = lowerer.unions.get(declared.unionId)?.arms ?? [];
  const declaredRecords = declaredArms.filter((arm) => arm.kind === "record");
  if (
    declaredRecords.length !== 1 ||
    !declaredArms.every((arm) => arm.kind === "record" || isUnitType(arm))
  )
    return null;
  const declaredShape = lowerer.shapes.get(
    (declaredRecords[0] as IrType & { kind: "record" }).shapeId,
  );
  if (
    !declaredShape ||
    declaredShape.tuple ||
    declaredShape.indexValue ||
    declaredShape.fields.length === 0 ||
    declaredShape.fields.every(
      (field) => lowerer.absentFieldValue(field.type, loc)?.kind === "fieldAbsent",
    )
  )
    return null;
  const left = lowerer.lowerExpr(init.left);
  // The stored operand can differ from the checker's view. A stored record
  // is never nullish (the fallback is dead); any other stored form must be
  // the same one record plus nullish arms.
  if (left.type.kind === "record") return left;
  if (left.type.kind !== "union") {
    lowerer.unsupported(
      "SC1031",
      init,
      "destructuring `x ?? {}` where the stored x is not one record or nullish (narrow first)",
    );
  }
  const sourceId = left.type.unionId;
  const arms = lowerer.unions.get(sourceId)?.arms ?? [];
  const records = arms.filter((arm) => arm.kind === "record");
  if (records.length !== 1 || !arms.every((arm) => arm.kind === "record" || isUnitType(arm))) {
    lowerer.unsupported(
      "SC1031",
      init,
      "destructuring `x ?? {}` where the stored x is not one record or nullish (narrow first)",
    );
  }
  const record = records[0] as IrType & { kind: "record" };
  const empty: IrType = { kind: "record", shapeId: lowerer.shapes.intern([]) };
  const resultArms = sortArms([record, empty]);
  const resultType: IrType = { kind: "union", unionId: lowerer.unions.intern(resultArms) };
  const sourceTag = arms.indexOf(record);
  const tmp = lowerer.declareHiddenLocal("%nullishEmpty", left.type);
  const ref: IrExpr = { kind: "varRef", localId: tmp.id, type: left.type, loc };
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: tmp.id, init: left, loc }],
    result: {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: sourceId,
        tag: sourceTag,
        negated: false,
        value: ref,
        type: BOOL,
        loc,
      },
      then: {
        kind: "unionWrap",
        unionId: resultType.unionId,
        tag: resultArms.indexOf(record),
        value: {
          kind: "unionNarrow",
          unionId: sourceId,
          tag: sourceTag,
          value: ref,
          type: record,
          loc,
        },
        type: resultType,
        loc,
      },
      else_: {
        kind: "unionWrap",
        unionId: resultType.unionId,
        tag: resultArms.indexOf(empty),
        value: { kind: "recordLit", fields: [], type: empty, loc },
        type: resultType,
        loc,
      },
      type: resultType,
      loc,
    },
    type: resultType,
    loc,
  };
}
