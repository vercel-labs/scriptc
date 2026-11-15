import {
  BOOL,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  UNDEFINED_T,
  isUnitType,
  sortArms,
} from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import { withoutParentheses, withoutParenthesesNonNull } from "../outer-expressions.js";
import type { Lowerer } from "./lowerer.js";
import { applyBindingDefault } from "./lower-stmts.js";

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
  const init = withoutParentheses(initializer);
  if (
    !ts.isBinaryExpression(init) ||
    (init.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
      init.operatorToken.kind !== ts.SyntaxKind.BarBarToken)
  )
    return null;
  const right = withoutParentheses(init.right);
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
      (field) => lowerer.absentFieldValue(field, loc)?.kind === "fieldAbsent",
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

/** `const [a, b] = table[key] ?? []` (also `|| []`, `cond ? pair : []` and
 * `cond ? [] : pair`) where the other operand is a tuple. The pattern
 * destructures either the tuple or an empty array, every position of which
 * reads undefined, so the checker types the bindings `T | undefined` and
 * the empty literal, from the pattern, as a tuple of undefined. The literal
 * has no element type of its own to build with, and it needs none: the
 * source is evaluated once and held as the tuple it selected or as "no
 * elements", and each binding, when it is reached, reads its position from
 * the held tuple or reads undefined, applies its default and binds. That is
 * the order Node iterates in, so a default that writes a later position of
 * the tuple is seen by the later binding.
 *
 * Only the empty literal stands for "no elements". Behind `??` and `||` a
 * nullish tuple operand selects the literal. A conditional selects by its
 * condition alone: when it picks the tuple arm and that arm holds null or
 * undefined (a lookup that found nothing), Node finds nothing to iterate
 * and throws a TypeError, and so does the lowering: `pair!` there asserts
 * nothing at run time, so the arm is read as the value it holds.
 *
 * Null (the caller keeps its current lowering) for JavaScript files, a
 * pattern with a rest element or a nested pattern, other initializer forms,
 * and an operand that is not one tuple beside nullish arms: an array
 * operand already takes the empty literal as its own array type. */
export function lowerTupleOrEmptyPattern(
  lowerer: Lowerer,
  pattern: ts.BindingName,
  initializer: ts.Expression,
  isLet: boolean,
): IrStmt[] | null {
  if (!ts.isArrayBindingPattern(pattern)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(initializer))) return null;
  for (const element of pattern.elements.nodes) {
    // A hole binds nothing.
    if (
      ts.isOmittedExpression(element) ||
      (element.name as ts.BindingName | undefined) === undefined
    )
      continue;
    if (element.dotDotDotToken !== undefined || !ts.isIdentifier(element.name)) return null;
  }
  const emptyLiteral = (node: ts.Expression): boolean => {
    const literal = withoutParentheses(node);
    return ts.isArrayLiteralExpression(literal) && literal.elements.nodes.length === 0;
  };
  const init = withoutParentheses(initializer);
  let operand: ts.Expression;
  let condition: { node: ts.Expression; emptyWhen: boolean } | null = null;
  if (
    ts.isBinaryExpression(init) &&
    (init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      init.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    emptyLiteral(init.right)
  ) {
    operand = init.left;
  } else if (ts.isConditionalExpression(init) && emptyLiteral(init.whenFalse)) {
    operand = withoutParenthesesNonNull(init.whenTrue);
    condition = { node: init.condition, emptyWhen: false };
  } else if (ts.isConditionalExpression(init) && emptyLiteral(init.whenTrue)) {
    operand = withoutParenthesesNonNull(init.whenFalse);
    condition = { node: init.condition, emptyWhen: true };
  } else return null;
  const loc = locOf(init);
  // Decide from the checker's view of the operand before lowering it once.
  const declared = lowerer.mapTypeOf(lowerer.checker.getNonNullableType(lowerer.typeOf(operand)));
  if (declared?.kind !== "record") return null;
  const tuple = lowerer.shapes.get(declared.shapeId);
  if (!tuple?.tuple || pattern.elements.nodes.length > tuple.fields.length) return null;
  const fields = tuple.fields.map((_, index) =>
    tuple.fields.find((candidate) => candidate.name === String(index)),
  );
  if (fields.some((field) => field === undefined)) return null;
  const positions = fields.map((field) => lowerer.runtimeOptionalType(field!.type));
  const out: IrStmt[] = [];
  // The condition is evaluated first and once; the tuple arm only when the
  // condition picks it.
  let picksTuple: IrExpr | null = null;
  if (condition !== null) {
    const picked = lowerer.declareHiddenLocal("%tupleOrEmptyPick", BOOL);
    const cond = lowerer.lowerCondition(condition.node);
    out.push({
      kind: "varDecl",
      localId: picked.id,
      init: condition.emptyWhen ? { kind: "unary", op: "!", operand: cond, type: BOOL, loc } : cond,
      loc,
    });
    picksTuple = varRef(picked.id, BOOL, loc);
  }
  const left = lowerer.lowerExpr(operand);
  const refuseStored: () => never = () =>
    lowerer.unsupported(
      "SC1031",
      init,
      "destructuring a tuple or `[]` where the stored tuple operand is not one tuple or nullish (narrow first)",
    );
  // The held source: the stored tuple itself when nothing else can be
  // selected, otherwise a union whose tuple arm is the selected tuple and
  // whose unit arms mean "no elements".
  let heldType: IrType;
  let value: IrExpr;
  if (left.type.kind === "record" && left.type.shapeId === declared.shapeId) {
    if (picksTuple === null) {
      // The stored operand is never nullish: the fallback is dead.
      heldType = left.type;
      value = left;
    } else {
      const arms = sortArms([declared, UNDEFINED_T]);
      const unionId = lowerer.unions.intern(arms);
      heldType = { kind: "union", unionId };
      const wrap = (tag: number, inner: IrExpr): IrExpr => ({
        kind: "unionWrap",
        unionId,
        tag,
        value: inner,
        type: heldType,
        loc,
      });
      value = {
        kind: "ternary",
        cond: picksTuple,
        then: wrap(arms.indexOf(declared), left),
        else_: wrap(arms.indexOf(UNDEFINED_T), {
          kind: "unitLit",
          unit: "undefined",
          type: UNDEFINED_T,
          loc,
        }),
        type: heldType,
        loc,
      };
    }
  } else if (left.type.kind === "union") {
    const arms = lowerer.unions.get(left.type.unionId)?.arms ?? [];
    const tag = arms.findIndex((arm) => arm.kind === "record" && arm.shapeId === declared.shapeId);
    const unit = arms.find(isUnitType);
    if (
      tag < 0 ||
      unit === undefined ||
      !arms.every((arm, index) => index === tag || isUnitType(arm))
    )
      refuseStored();
    heldType = left.type;
    value =
      picksTuple === null
        ? left
        : {
            kind: "ternary",
            cond: picksTuple,
            then: left,
            else_: lowerer.coerceToExpected(
              {
                kind: "unitLit",
                unit: unit!.kind === "nullT" ? "null" : "undefined",
                type: unit!,
                loc,
              },
              heldType,
            ),
            type: heldType,
            loc,
          };
  } else refuseStored();
  const held = lowerer.declareHiddenLocal("%tupleOrEmpty", heldType);
  out.push({ kind: "varDecl", localId: held.id, init: value, loc });
  const heldRef = (): IrExpr => varRef(held.id, heldType, loc);
  let tupleTag: number | null = null;
  if (heldType.kind === "union") {
    const unionId = heldType.unionId;
    const arms = lowerer.unions.get(unionId)?.arms ?? [];
    tupleTag = arms.findIndex((arm) => arm.kind === "record" && arm.shapeId === declared.shapeId);
    if (picksTuple !== null && left.type.kind === "union") {
      // The condition picked the tuple arm and it holds no tuple: Node
      // asks the value for its iterator and throws. V8 words a
      // conditional source by its three operands, none of which it names.
      out.push({
        kind: "if",
        cond: {
          kind: "logical",
          op: "&&",
          left: picksTuple,
          right: {
            kind: "unionIsTag",
            unionId,
            tag: tupleTag,
            value: heldRef(),
            negated: true,
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value:
                    "(intermediate value)(intermediate value)(intermediate value) is not iterable",
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      });
    }
  }
  pattern.elements.nodes.forEach((element, index) => {
    if (
      ts.isOmittedExpression(element) ||
      (element.name as ts.BindingName | undefined) === undefined
    )
      return;
    const elementLoc = locOf(element);
    const positionType = positions[index]!;
    const read = (tupleValue: IrExpr): IrExpr =>
      lowerer.coerceToExpected(
        {
          kind: "recordGet",
          obj: tupleValue,
          shapeId: declared.shapeId,
          field: String(index),
          type: fields[index]!.type,
          loc: elementLoc,
        },
        positionType,
      );
    const position: IrExpr =
      heldType.kind !== "union" || tupleTag === null
        ? read(heldRef())
        : {
            kind: "ternary",
            cond: {
              kind: "unionIsTag",
              unionId: heldType.unionId,
              tag: tupleTag,
              negated: false,
              value: heldRef(),
              type: BOOL,
              loc: elementLoc,
            },
            then: read({
              kind: "unionNarrow",
              unionId: heldType.unionId,
              tag: tupleTag,
              value: heldRef(),
              type: declared,
              loc: elementLoc,
            }),
            else_: lowerer.coerceToExpected(
              { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: elementLoc },
              positionType,
            ),
            type: positionType,
            loc: elementLoc,
          };
    // The position is read once, when its binding is reached, and before
    // its default runs.
    const at = lowerer.declareHiddenLocal("%tupleOrEmptyAt", positionType);
    out.push({ kind: "varDecl", localId: at.id, init: position, loc: elementLoc });
    let bound: IrExpr = varRef(at.id, positionType, elementLoc);
    if (element.initializer) bound = applyBindingDefault(lowerer, element, bound);
    lowerer.bindPatternTarget(element.name!, bound, isLet, out);
  });
  return out;
}
