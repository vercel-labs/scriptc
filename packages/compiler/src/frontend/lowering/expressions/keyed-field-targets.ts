/* Computed record keys: read-modify-write targets (`r[k] op= v`, `r[k]++`, `r[k] ??= v`) and runtime-keyed destructuring reads. */
import * as ts from "../../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  typeEquals,
  type IrExpr,
  type IrStmt,
  type SrcLoc,
} from "../../../ir/ir.js";
import { isJsSourceFile } from "../../program.js";
import { constituentTypes } from "../../ts7/checker.js";
import type { FieldTarget } from "../lower-exprs.js";
import type { Lowerer } from "../lowerer.js";

export type KeyedFieldTarget = FieldTarget & { container: "recordKeyed" };

/** The property names a computed key's type allows: one or more string
 * literals (a literal union such as `"sent" | "received"`, enum string
 * members, or a type parameter bound to one inside a generic instance).
 * Null for any other key type. */
export function literalFieldKeys(lowerer: Lowerer, keyNode: ts.Expression): string[] | null {
  let t: ts.Type = lowerer.typeOf(keyNode);
  if (t.flags & ts.TypeFlags.TypeParameter) {
    const bound = lowerer.typeParamTsResolver(t);
    if (!bound) return null;
    t = bound;
  }
  const parts = t.flags & ts.TypeFlags.Union ? constituentTypes(t) : [t];
  const keys: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteralType()) return null;
    if (!keys.includes(part.value)) keys.push(part.value);
  }
  return keys.length > 0 ? keys : null;
}

/** Does `r[k]` read and write through declared record storage by key? A
 * checker-only test (nothing lowers), so a caller can route before it
 * evaluates the receiver: TypeScript sources only, a record whose declared
 * fields include every name the key's literal type allows, or a pure
 * index-signature record with a string key. */
export function isKeyedFieldAccess(lowerer: Lowerer, access: ts.ElementAccessExpression): boolean {
  if (
    access.questionDotToken ||
    isJsSourceFile(ts.getSourceFileOfNode(access)) ||
    lowerer.isProcessEnv(access.expression)
  )
    return false;
  const keys = literalFieldKeys(lowerer, access.argumentExpression);
  if (!keys && !(lowerer.typeOf(access.argumentExpression).flags & ts.TypeFlags.StringLike))
    return false;
  const receiver = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiver?.kind !== "record") return false;
  const shape = lowerer.shapes.get(receiver.shapeId);
  if (!shape || shape.tuple) return false;
  if (shape.fields.length === 0) return shape.indexValue !== undefined;
  return keys !== null && keys.every((k) => shape.fields.some((f) => f.name === k));
}

/** The target of a read-modify-write through `r[k]`, or null when
 * isKeyedFieldAccess declines. A literal-union key dispatches over the
 * declared fields it names, which must share one type; a string key on a
 * pure index-signature record reads and writes its entries. The receiver
 * and key may arrive already lowered (and saved) by the caller; otherwise
 * both lower here, unsaved. A caller that evaluates the target more than
 * once saves `obj` and then `key`, the JavaScript evaluation order. With
 * `numeric`, a missing index-signature entry reads as NaN (every numeric
 * update applies ToNumber to it) instead of a value armed with undefined. */
export function keyedFieldTarget(
  lowerer: Lowerer,
  access: ts.ElementAccessExpression,
  numeric: boolean,
  lowered?: { obj: IrExpr; key: IrExpr },
): KeyedFieldTarget | null {
  if (!isKeyedFieldAccess(lowerer, access)) return null;
  const keyNode = access.argumentExpression;
  const keys = literalFieldKeys(lowerer, keyNode);
  const obj = lowered?.obj ?? lowerer.lowerExpr(access.expression);
  if (obj.type.kind !== "record") {
    lowerer.unsupported(
      "SC1090",
      access.expression,
      `updating a computed key of a '${lowerer.fmt(obj.type)}' value (narrow the receiver to its record type first)`,
    );
  }
  const shapeId = obj.type.shapeId;
  const shape = lowerer.shapes.get(shapeId)!;
  // A single literal spelled at the site (or an identifier whose type is
  // that one literal) names the field statically: identifier evaluation
  // is pure, so skipping it matches JavaScript.
  const indexed = shape.fields.length === 0;
  const staticKey =
    !indexed && keys?.length === 1 && (ts.isStringLiteralLike(keyNode) || ts.isIdentifier(keyNode));
  const key = staticKey ? null : (lowered?.key ?? lowerer.lowerExpr(keyNode));
  if (key && key.type.kind !== "string") {
    lowerer.unsupported(
      "SC1090",
      keyNode,
      `updating a record through a '${lowerer.fmt(key.type)}' key (convert the key to a string first)`,
    );
  }
  if (keys && !indexed) {
    const fields = keys.map((k) => shape.fields.find((f) => f.name === k));
    const first = fields[0];
    if (!first || fields.some((f) => !f || !typeEquals(f.type, first.type))) {
      lowerer.unsupported(
        "SC1090",
        access,
        `updating '${lowerer.fmt(obj.type)}' through a key whose fields are not all stored with one type (${keys.map((k) => `'${k}'`).join(", ")}; switch over the key and update each field)`,
      );
    }
    return {
      container: "recordKeyed",
      obj,
      shapeId,
      field: keys[0]!,
      keys,
      key,
      fieldType: first.type,
    };
  }
  if (!indexed || !shape.indexValue) {
    lowerer.unsupported(
      "SC1090",
      access,
      `updating '${lowerer.fmt(obj.type)}' through a runtime key (the stored record declares fields)`,
    );
  }
  return {
    container: "recordKeyed",
    obj,
    shapeId,
    field: "",
    keys: null,
    key,
    fieldType: shape.indexValue,
    ...(numeric && shape.indexValue.kind === "f64" ? { missNaN: true as const } : {}),
  };
}

/** Does `key` name `field`? */
function keyIs(key: IrExpr, field: string, loc: SrcLoc): IrExpr {
  return {
    kind: "strEq",
    negated: false,
    left: key,
    right: { kind: "strLit", value: field, type: STRING, loc },
    type: BOOL,
    loc,
  };
}

/** A key outside its literal type (smuggled through a cast) names no
 * declared field: a fixed-shape record cannot add the property, so an
 * update throws the TypeError of a keyed write miss, and a plain read the
 * keyed read miss's (no undefined is representable in the field type). */
function keyMiss(key: IrExpr, target: KeyedFieldTarget, loc: SrcLoc, read = false): IrExpr {
  const message: IrExpr = {
    kind: "strConcat",
    left: {
      kind: "strConcat",
      left: {
        kind: "strLit",
        value: read ? "record has no key '" : "Cannot add property '",
        type: STRING,
        loc,
      },
      right: key,
      type: STRING,
      loc,
    },
    right: {
      kind: "strLit",
      value: read ? "' (typed slot — no undefined is representable)" : "' to a fixed-shape object",
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
  return {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [
      { kind: "numLit", value: 1, type: F64, loc },
      { kind: "strLit", value: "", type: STRING, loc },
      message,
    ],
    type: target.fieldType,
    loc,
  };
}

/** The current value of a keyed target. `read` marks a read that no
 * write follows (a destructuring element), which words a key miss as a
 * read. */
export function keyedFieldRead(
  lowerer: Lowerer,
  target: KeyedFieldTarget,
  loc: SrcLoc,
  read = false,
): IrExpr {
  const { obj, shapeId, key, fieldType } = target;
  if (!target.keys) {
    const type = target.missNaN
      ? fieldType
      : fieldType.kind === "dyn"
        ? fieldType
        : lowerer.withUndefinedArmOf(fieldType);
    if (!type || !key) throw new Error("keyed index-signature target without a key or read type");
    return {
      kind: "recordKeyGet",
      obj,
      shapeId,
      key,
      ...(target.missNaN ? { missNaN: true as const } : {}),
      type,
      loc,
    };
  }
  const get = (field: string): IrExpr => ({
    kind: "recordGet",
    obj,
    shapeId,
    field,
    type: fieldType,
    loc,
  });
  if (!key) return get(target.keys[0]!);
  return target.keys.reduceRight<IrExpr>(
    (otherwise, field) => ({
      kind: "ternary",
      cond: keyIs(key, field, loc),
      then: get(field),
      else_: otherwise,
      type: fieldType,
      loc,
    }),
    keyMiss(key, target, loc, read),
  );
}

/** Store `value` (already of the target's field type) through a keyed
 * target. A multi-key dispatch references the value once per field, so a
 * value that is not a plain local is saved first. */
export function keyedFieldWrite(
  lowerer: Lowerer,
  target: KeyedFieldTarget,
  value: IrExpr,
  loc: SrcLoc,
): IrStmt {
  const { obj, shapeId, key } = target;
  if (!target.keys) {
    if (!key) throw new Error("keyed index-signature target without a key");
    return { kind: "recordKeySet", obj, shapeId, key, value, loc };
  }
  if (!key) return { kind: "recordSet", obj, shapeId, field: target.keys[0]!, value, loc };
  const prefix: IrStmt[] = [];
  let stored = value;
  if (value.kind !== "varRef") {
    const local = lowerer.declareHiddenLocal("%keyedValue", value.type);
    prefix.push({ kind: "varDecl", localId: local.id, init: value, loc });
    stored = { kind: "varRef", localId: local.id, type: value.type, loc };
  }
  const chain = target.keys.reduceRight<IrStmt[]>(
    (otherwise, field) => [
      {
        kind: "if",
        cond: keyIs(key, field, loc),
        then: [{ kind: "recordSet", obj, shapeId, field, value: stored, loc }],
        else_: otherwise,
        loc,
      },
    ],
    [{ kind: "exprStmt", expr: keyMiss(key, target, loc), loc }],
  );
  return { kind: "block", body: [...prefix, ...chain], loc };
}

/** Save a keyed target's key after its receiver, so a multi-key dispatch
 * reads and writes the field the key named when it was evaluated. */
export function saveKeyedFieldKey(
  target: FieldTarget,
  save: (value: IrExpr, name: string) => IrExpr,
): void {
  if (target.container === "recordKeyed" && target.key) target.key = save(target.key, "%keyedKey");
}

/** The value a destructuring element with a runtime computed key binds
 * (`const { [name]: v } = source`), or null when the source's
 * representation has no keyed read for that key. The key evaluates here,
 * once, into `out` (element order), and converts with ToPropertyKey:
 * - a checked-dynamic source (or a JavaScript record, through its checked
 *   view) reads the live property, undefined when absent;
 * - a pure index-signature record reads its entry, undefined when absent;
 * - a record whose declared fields include every name the key's literal
 *   type allows, all stored with one type, reads the field the key names. */
export function runtimeKeyPatternRead(
  lowerer: Lowerer,
  keyNode: ts.Expression,
  source: IrExpr,
  out: IrStmt[],
  loc: SrcLoc,
): IrExpr | null {
  const save = (value: IrExpr, name: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, value.type);
    out.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return { kind: "varRef", localId: local.id, type: value.type, loc };
  };
  const jsRecord =
    source.type.kind === "record" &&
    isJsSourceFile(keyNode.getSourceFile()) &&
    lowerer.dynConvertible(source.type);
  if (source.type.kind === "dyn" || jsRecord) {
    const raw = lowerer.lowerExpr(keyNode);
    if (!lowerer.dynConvertible(raw.type)) return null;
    const key = save(
      {
        kind: "libCall",
        fn: "dyn.propertyKey",
        args: [lowerer.coerceInto(keyNode, raw, DYN)],
        type: DYN,
        loc,
      },
      "%patternKey",
    );
    return { kind: "dynKeyGet", value: lowerer.coerceToExpected(source, DYN), key, type: DYN, loc };
  }
  if (source.type.kind !== "record") return null;
  const shapeId = source.type.shapeId;
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple) return null;
  if (shape.fields.length === 0 && shape.indexValue) {
    const raw = lowerer.lowerExpr(keyNode);
    if (raw.type.kind !== "string") return null;
    const type =
      shape.indexValue.kind === "dyn"
        ? shape.indexValue
        : lowerer.withUndefinedArmOf(shape.indexValue);
    if (!type) return null;
    const key = save(raw, "%patternKey");
    return { kind: "recordKeyGet", obj: source, shapeId, key, type, loc };
  }
  const keys = literalFieldKeys(lowerer, keyNode);
  const fields = keys?.map((k) => shape.fields.find((f) => f.name === k));
  const first = fields?.[0];
  if (!keys || !first || fields!.some((f) => !f || !typeEquals(f.type, first.type))) return null;
  const raw = lowerer.lowerExpr(keyNode);
  if (raw.type.kind !== "string") return null;
  const target: KeyedFieldTarget = {
    container: "recordKeyed",
    obj: source,
    shapeId,
    field: keys[0]!,
    keys,
    key: save(raw, "%patternKey"),
    fieldType: first.type,
  };
  return keyedFieldRead(lowerer, target, loc, true);
}
