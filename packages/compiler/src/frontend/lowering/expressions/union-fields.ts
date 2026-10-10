import { nodeThrowExpr, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { narrowStoredClassValue } from "../class-unions.js";
import {
  BOOL,
  type IrExpr,
  type IrStmt,
  type IrType,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { locOf, isJsSourceFile } from "../../program.js";

/** One class or record arm of a union receiver and its declared field. */
interface UnionFieldArm {
  receiver: IrType & { kind: "record" | "object" };
  type: IrType;
}

/** The declared data field `name` of a class or record arm, or null when the
 * arm has none (accessors, index signatures and other kinds included). */
function unionFieldArm(lowerer: Lowerer, arm: IrType, name: string): UnionFieldArm | null {
  if (arm.kind === "record") {
    const type = lowerer.shapes.get(arm.shapeId)?.fields.find((f) => f.name === name)?.type;
    return type ? { receiver: arm, type } : null;
  }
  if (arm.kind === "object") {
    const type = lowerer.classes.get(arm.className)?.fields.get(name);
    return type ? { receiver: arm, type } : null;
  }
  return null;
}

/** The arm's slot read from `union`, assuming the runtime tag is `tag`. */
function unionFieldRead(
  unionId: string,
  tag: number,
  union: IrExpr,
  field: UnionFieldArm,
  name: string,
  loc: IrExpr["loc"],
): IrExpr {
  const obj: IrExpr = {
    kind: "unionNarrow",
    unionId,
    tag,
    value: union,
    type: field.receiver,
    loc,
  };
  return field.receiver.kind === "record"
    ? {
        kind: "recordGet",
        obj,
        shapeId: field.receiver.shapeId,
        field: name,
        type: field.type,
        loc,
      }
    : {
        kind: "fieldGet",
        obj,
        className: field.receiver.className,
        field: name,
        type: field.type,
        loc,
      };
}

/** Whether `converted` is `value` itself or `value` wrapped into a union
 * or upcast to a base class: conversions that cannot fail. Checked
 * narrowings (a union into one of its arms) don't count. */
function isWidening(converted: IrExpr, value: IrExpr): boolean {
  if (converted === value) return true;
  return (
    (converted.kind === "unionWrap" || converted.kind === "upcast") &&
    isWidening(converted.value, value)
  );
}

/** The field type every arm's field converts into without a check (an
 * identical type, a union wrap, or a class upcast), or null. Candidates
 * are the arms' own field types, probed with the arms' slot reads. */
function sharedFieldType(
  lowerer: Lowerer,
  unionId: string,
  union: IrExpr,
  fields: UnionFieldArm[],
  name: string,
  loc: IrExpr["loc"],
  widest: boolean,
): IrType | null {
  for (let candidate = 0; candidate < fields.length; candidate++) {
    const target = fields[candidate]!.type;
    let accepted = true;
    for (let tag = 0; tag < fields.length && accepted; tag++) {
      const from = widest ? fields[tag]! : fields[candidate]!;
      const to = widest ? target : fields[tag]!.type;
      const probe = unionFieldRead(unionId, widest ? tag : candidate, union, from, name, loc);
      const converted = lowerer.coerceToExpected(probe, to);
      accepted = typeEquals(converted.type, to) && isWidening(converted, probe);
    }
    if (accepted) return target;
  }
  return null;
}

/** Read a data field from a union of classes and records whose arms declare
 * it with DIFFERENT but compatible types (`T | undefined` beside `T`, a base
 * class beside a subclass). Each tag reads its own slot and converts it to
 * the widest arm type, so the result has one representation; the caller
 * narrows it to the checker's flow type. Unit arms, accessors, and fields
 * without a common type keep their existing fences. */
export function lowerUnionFieldRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  receiver: IrExpr,
): IrExpr | null {
  if (receiver.type.kind !== "union" || isJsSourceFile(access.getSourceFile())) return null;
  const unionId = receiver.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms || arms.length < 2) return null;
  const name = access.name.text;
  const fields: UnionFieldArm[] = [];
  for (const arm of arms) {
    const field = unionFieldArm(lowerer, arm, name);
    if (!field || field.type.kind === "void" || isUnitType(field.type)) return null;
    fields.push(field);
  }
  const loc = locOf(access);
  const type = sharedFieldType(lowerer, unionId, receiver, fields, name, loc, true);
  if (type === null) return null;
  const object = lowerer.declareHiddenLocal("%unionReadObject", receiver.type);
  const objectRef = varRef(object.id, object.type, loc);
  let dispatch: IrExpr = lowerer.coerceToExpected(
    unionFieldRead(unionId, fields.length - 1, objectRef, fields[fields.length - 1]!, name, loc),
    type,
  );
  for (let tag = fields.length - 2; tag >= 0; tag--) {
    dispatch = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, value: objectRef, negated: false, type: BOOL, loc },
      then: lowerer.coerceToExpected(
        unionFieldRead(unionId, tag, objectRef, fields[tag]!, name, loc),
        type,
      ),
      else_: dispatch,
      type,
      loc,
    };
  }
  const init: IrStmt = { kind: "varDecl", localId: object.id, init: receiver, loc };
  return { kind: "seqExpr", stmts: [init], result: dispatch, type, loc };
}

/** Assign a common data field without projecting the union's objects into
 * a new structural shape. Each tag writes the original payload, so
 * aliases and identity-keyed collections observe the mutation. Arms may
 * declare the field with different types when one of them converts into
 * every other without a check (`T` beside `T | undefined`, a subclass
 * beside its base): the value is evaluated as that type and widened per
 * arm. Accessors, missing fields, and unrelated storage types retain their
 * own fences. */
export function lowerUnionFieldWrite(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  rhs: ts.Expression,
): IrExpr | null {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (access.questionDotToken || mapped?.kind !== "union") return null;
  let receiver = lowerer.maybeNarrow(lowerer.lowerExpr(access.expression), access.expression);
  // Optional base-class storage narrowed to several subclasses (see
  // lowerUnionProperty): extract the instance and test its class.
  if (receiver.type.kind === "union" && !typeEquals(receiver.type, mapped))
    receiver = narrowStoredClassValue(lowerer, receiver, mapped) ?? receiver;
  if (receiver.type.kind !== "union") return null;
  const unionId = receiver.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms?.length) return null;
  const name = access.name.text;
  const loc = locOf(access);
  const fields: (UnionFieldArm | null)[] = [];
  const present: UnionFieldArm[] = [];
  for (const arm of arms) {
    if (arm.kind === "undefinedT" || arm.kind === "nullT") {
      fields.push(null);
      continue;
    }
    const field = unionFieldArm(lowerer, arm, name);
    if (!field) return null;
    fields.push(field);
    present.push(field);
  }
  if (present.length === 0) return null;
  let fieldType: IrType | null = present[0]!.type;
  if (present.some((field) => !typeEquals(field.type, present[0]!.type))) {
    // Mixed storage types are probed only on unions without unit arms, where
    // the present arms' tags are the union's own.
    fieldType =
      present.length === fields.length
        ? sharedFieldType(lowerer, unionId, receiver, present, name, loc, false)
        : null;
  }
  if (fieldType === null) return null;
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
      const slotValue = lowerer.coerceToExpected(result, field.type);
      const write: IrStmt =
        field.receiver.kind === "record"
          ? {
              kind: "recordSet",
              obj,
              shapeId: field.receiver.shapeId,
              field: name,
              value: slotValue,
              loc,
            }
          : {
              kind: "fieldSet",
              obj,
              className: field.receiver.className,
              field: name,
              value: slotValue,
              loc,
            };
      branch = { kind: "seqExpr", stmts: [write], result, type: result.type, loc };
    } else {
      branch = nodeThrowExpr(
        1,
        "",
        `Cannot set properties of ${arms[tag]!.kind === "nullT" ? "null" : "undefined"} (setting '${name}')`,
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
