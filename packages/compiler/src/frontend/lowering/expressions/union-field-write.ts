import { nodeThrowExpr, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { BOOL, type IrExpr, type IrStmt, type IrType, typeEquals } from "../../../ir/ir.js";
import { locOf } from "../../program.js";

/** Assign a common data field without projecting the union's objects into
 * a new structural shape. Each tag writes the original payload, so
 * aliases and identity-keyed collections observe the mutation. Accessors,
 * missing fields, and differently typed storage retain their own fences. */
export function lowerUnionFieldWrite(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  rhs: ts.Expression,
): IrExpr | null {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (access.questionDotToken || mapped?.kind !== "union") return null;
  const receiver = lowerer.maybeNarrow(lowerer.lowerExpr(access.expression), access.expression);
  if (receiver.type.kind !== "union") return null;
  const unionId = receiver.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms?.length) return null;
  const fields: ({ receiver: IrType & { kind: "record" | "object" }; type: IrType } | null)[] = [];
  let fieldType: IrType | null = null;
  for (const arm of arms) {
    if (arm.kind === "undefinedT" || arm.kind === "nullT") {
      fields.push(null);
      continue;
    }
    if (arm.kind !== "record" && arm.kind !== "object") return null;
    const type =
      arm.kind === "record"
        ? lowerer.shapes.get(arm.shapeId)?.fields.find((f) => f.name === access.name.text)?.type
        : lowerer.classes.get(arm.className)?.fields.get(access.name.text);
    if (!type || (fieldType !== null && !typeEquals(fieldType, type))) return null;
    fieldType = type;
    fields.push({ receiver: arm, type });
  }
  if (fieldType === null) return null;
  const loc = locOf(access);
  const object = lowerer.declareHiddenLocal("%unionWriteObject", receiver.type);
  const objectRef = varRef(object.id, object.type, loc);
  const value = lowerer.lowerExprExpecting(rhs, fieldType);
  const stored = lowerer.declareHiddenLocal("%unionWriteValue", value.type);
  // Snapshot the reference before evaluating the RHS, which can change the
  // original binding. Evaluate and retain the value once before dispatch.
  const body: IrStmt[] = [
    { kind: "varDecl", localId: object.id, init: receiver, loc },
    { kind: "varDecl", localId: stored.id, init: value, loc },
  ];
  const result = varRef(stored.id, stored.type, loc);
  let dispatch: IrExpr = result;
  for (let tag = fields.length - 1; tag >= 0; tag--) {
    const field = fields[tag];
    let branch: IrExpr;
    if (field) {
      const obj: IrExpr = {
        kind: "unionNarrow",
        unionId,
        tag,
        value: objectRef,
        type: field.receiver,
        loc,
      };
      const write: IrStmt =
        field.receiver.kind === "record"
          ? {
              kind: "recordSet",
              obj,
              shapeId: field.receiver.shapeId,
              field: access.name.text,
              value: result,
              loc,
            }
          : {
              kind: "fieldSet",
              obj,
              className: field.receiver.className,
              field: access.name.text,
              value: result,
              loc,
            };
      branch = { kind: "seqExpr", stmts: [write], result, type: result.type, loc };
    } else {
      branch = nodeThrowExpr(
        1,
        "",
        `Cannot set properties of ${arms[tag]!.kind === "nullT" ? "null" : "undefined"} (setting '${access.name.text}')`,
        result.type,
        loc,
      );
    }
    dispatch =
      tag === fields.length - 1
        ? branch
        : {
            kind: "ternary",
            cond: {
              kind: "unionIsTag",
              unionId,
              tag,
              value: objectRef,
              negated: false,
              type: BOOL,
              loc,
            },
            then: branch,
            else_: dispatch,
            type: result.type,
            loc,
          };
  }
  return { kind: "seqExpr", stmts: body, result: dispatch, type: result.type, loc };
}
