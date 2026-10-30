import { nodeThrowExpr, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { narrowStoredClassValue } from "../class-unions.js";
import { markSloppyRecordWrites } from "../frozen-records.js";
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

/** Whether `converted` is `value` itself or `value` wrapped into a union,
 * upcast to a base class, or boxed into the checked-dynamic representation:
 * conversions that cannot fail. Checked narrowings (a union into one of its
 * arms) don't count. */
function isWidening(converted: IrExpr, value: IrExpr): boolean {
  if (converted === value) return true;
  return (
    (converted.kind === "unionWrap" ||
      converted.kind === "upcast" ||
      converted.kind === "dynFrom") &&
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
 * class beside a subclass, `T` beside `unknown`). Each tag reads its own slot
 * and converts it to the widest arm type, so the result has one
 * representation; the caller narrows it to the checker's flow type. Unit
 * arms, accessors, and fields without a common type keep their existing
 * fences. */
export function lowerUnionFieldRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  receiver: IrExpr,
): IrExpr | null {
  if (receiver.type.kind !== "union" || isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
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
 * beside its base), or when one arm declares the field `unknown`/`any`
 * beside specific arms (`T | undefined` beside `unknown`) and the value is
 * converted per arm. A union of unrelated static storage types (a
 * `string` arm beside a `number` arm) keeps its refusal: there is no
 * dynamic arm to make the write meaningful, and the read path refuses the
 * same shape. Accessors, missing fields, and unrelated storage types retain
 * their own fences. */
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
  const mixed = present.some((field) => !typeEquals(field.type, present[0]!.type));
  let fieldType: IrType | null = present[0]!.type;
  if (mixed) {
    // Mixed storage types are probed only on unions without unit arms, where
    // the present arms' tags are the union's own.
    fieldType =
      present.length === fields.length
        ? sharedFieldType(lowerer, unionId, receiver, present, name, loc, false)
        : null;
  }
  if (
    fieldType === null &&
    (!mixed ||
      !present.some((field) => field.type.kind === "dyn") ||
      !present.every((field) => lowerer.dynConvertible(field.type)))
  )
    return null;
  const object = lowerer.declareHiddenLocal("%unionWriteObject", receiver.type);
  const objectRef = varRef(object.id, object.type, loc);
  // No static supertype of the arm types, with one arm's slot dynamic
  // (`T | undefined` beside `unknown`): TypeScript's writable property type
  // is the UNION of the arms' property types, so the value is lowered once
  // at its own type and each arm converts it. Those conversions are checked
  // where the arm's slot is narrower, so a value that does not fit the
  // selected arm throws the catchable TypeError of the dyn→static edge
  // where JS would store it (the divergence a dyn value written into a
  // typed slot already documents).
  const value =
    fieldType === null ? lowerer.lowerExpr(rhs) : lowerer.lowerExprExpecting(rhs, fieldType);
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
      // A sloppy-mode write to a frozen record leaves it unchanged.
      if (write.kind === "recordSet") markSloppyRecordWrites(lowerer, write, access);
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

/** `delete u.f` on a union receiver: each record arm declares `f` as an
 * OPTIONAL field (an undefined-armed slot), so each tag writes its own
 * slot's ABSENT state — the monomorphic optional-field delete, dispatched
 * over the arms the way union field writes are. The union value is
 * retained once, so every arm deletes the object the program passed, not a
 * projection. Null when an arm is not a record that declares `f` optional
 * (unit arms, class arms, required fields, accessors and index signatures
 * keep their own fences): a required slot has no absence to represent. */
export function lowerUnionFieldDelete(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrStmt | null {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (access.questionDotToken || mapped?.kind !== "union") return null;
  let receiver = lowerer.maybeNarrow(lowerer.lowerExpr(access.expression), access.expression);
  if (receiver.type.kind === "union" && !typeEquals(receiver.type, mapped))
    receiver = narrowStoredClassValue(lowerer, receiver, mapped) ?? receiver;
  if (receiver.type.kind !== "union") return null;
  const unionId = receiver.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms || arms.length < 2) return null;
  const name = access.name.text;
  const loc = locOf(access);
  const fields: { arm: IrType & { kind: "record" }; type: IrType }[] = [];
  for (const arm of arms) {
    if (arm.kind !== "record" || lowerer.shapes.get(arm.shapeId)?.tuple) return null;
    const field = unionFieldArm(lowerer, arm, name);
    if (!field || lowerer.absentFieldValue(field.type, loc) === null) return null;
    fields.push({ arm, type: field.type });
  }
  const object = lowerer.declareHiddenLocal("%unionDeleteObject", receiver.type);
  const objectRef = varRef(object.id, object.type, loc);
  const branch = (tag: number): IrStmt[] => {
    const field = fields[tag]!;
    const absent = lowerer.absentFieldValue(field.type, loc);
    if (absent === null) return [];
    const write: IrStmt = {
      kind: "recordSet",
      obj: { kind: "unionNarrow", unionId, tag, value: objectRef, type: field.arm, loc },
      shapeId: field.arm.shapeId,
      field: name,
      value: absent,
      loc,
    };
    // A sloppy-mode delete on a frozen record leaves it unchanged.
    markSloppyRecordWrites(lowerer, write, access);
    return [write];
  };
  // One tag test per arm, the last arm as the fall-through else: a delete
  // runs at most one arm's write.
  const dispatch = (tag: number): IrStmt[] =>
    tag === fields.length - 1
      ? branch(tag)
      : [
          {
            kind: "if",
            cond: {
              kind: "unionIsTag",
              unionId,
              tag,
              value: objectRef,
              negated: false,
              type: BOOL,
              loc,
            },
            then: branch(tag),
            else_: dispatch(tag + 1),
            loc,
          },
        ];
  return {
    kind: "block",
    body: [{ kind: "varDecl", localId: object.id, init: receiver, loc }, ...dispatch(0)],
    loc,
  };
}

/** Read the element at a literal index from a union of tuples whose element
 * types differ (`readonly [true, number] | readonly [false, string]`, index
 * 1): each tag reads its own tuple's slot and widens it into the union of
 * the arms' element types; the caller narrows the result to the checker's
 * flow type. Null when an arm is not a tuple with that position. */
export function lowerUnionTupleRead(
  lowerer: Lowerer,
  receiver: IrExpr,
  index: number,
  loc: IrExpr["loc"],
): IrExpr | null {
  if (receiver.type.kind !== "union" || !Number.isInteger(index) || index < 0) return null;
  const unionId = receiver.type.unionId;
  const arms = lowerer.unions.get(unionId)?.arms;
  if (!arms || arms.length < 2) return null;
  const name = String(index);
  const fields: UnionFieldArm[] = [];
  const parts: IrType[] = [];
  for (const arm of arms) {
    if (arm.kind !== "record" || lowerer.shapes.get(arm.shapeId)?.tuple !== true) return null;
    const field = unionFieldArm(lowerer, arm, name);
    if (!field || field.type.kind === "void") return null;
    fields.push(field);
    const own =
      field.type.kind === "union" ? lowerer.unions.get(field.type.unionId)?.arms : [field.type];
    if (!own) return null;
    for (const part of own) if (!parts.some((p) => typeEquals(p, part))) parts.push(part);
  }
  const type: IrType =
    parts.length === 1 ? parts[0]! : { kind: "union", unionId: lowerer.unions.intern(parts) };
  const object = lowerer.declareHiddenLocal("%unionReadObject", receiver.type);
  const objectRef = varRef(object.id, object.type, loc);
  const read = (tag: number): IrExpr | null => {
    const probe = unionFieldRead(unionId, tag, objectRef, fields[tag]!, name, loc);
    const converted = lowerer.coerceToExpected(probe, type);
    return typeEquals(converted.type, type) && isWidening(converted, probe) ? converted : null;
  };
  let dispatch = read(fields.length - 1);
  if (!dispatch) return null;
  for (let tag = fields.length - 2; tag >= 0; tag--) {
    const then = read(tag);
    if (!then) return null;
    dispatch = {
      kind: "ternary",
      cond: { kind: "unionIsTag", unionId, tag, value: objectRef, negated: false, type: BOOL, loc },
      then,
      else_: dispatch,
      type,
      loc,
    };
  }
  const init: IrStmt = { kind: "varDecl", localId: object.id, init: receiver, loc };
  return { kind: "seqExpr", stmts: [init], result: dispatch, type, loc };
}
