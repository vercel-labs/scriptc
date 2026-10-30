import {
  accessorSlotProp,
  typeKey,
  isDirentShape,
  recordTextCodecClass,
  type IrClassDef,
  type IrExpr,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
  type IrType,
} from "./ir.js";
import { everyStmtList } from "./traverse.js";
import { NativeTypes, reachNativeTypes } from "./native-types.js";

/** Fixed native records own their declared slots. Tuples, index storage and
 * runtime-owned records need their distinct mutation owners. */
export function nativeRecordIntegrityEligible(shape: IrRecordShape): boolean {
  return (
    !shape.tuple &&
    !shape.indexValue &&
    !isDirentShape(shape) &&
    recordTextCodecClass(shape) === null
  );
}

/** Shared by guard insertion and pre-emission effect/link analysis. */
export function nativeRecordWritePredicate(
  mod: IrModule,
  exposed = computeNativeIntegrityTypes(mod),
): (stmt: IrStmt) => stmt is Extract<IrStmt, { kind: "recordSet" | "recordKeySet" }> {
  const records = new Set(
    (mod.records ?? [])
      .filter((shape) => exposed?.recordGuarded(shape.id) && nativeRecordIntegrityEligible(shape))
      .map((shape) => shape.id),
  );
  return (stmt): stmt is Extract<IrStmt, { kind: "recordSet" | "recordKeySet" }> =>
    ((stmt.kind === "recordSet" && accessorSlotProp(stmt.field) === null) ||
      stmt.kind === "recordKeySet") &&
    records.has(stmt.shapeId);
}

/** A guarded Set may invoke a prototype setter before LLVM inserts its guard.
 * Include receiver boxing: its live adapter can expose Promise-bearing fields. */
export function computeNativeSetEffects(mod: IrModule): {
  callsSetter: boolean;
  boxedTypes: IrType[];
} {
  const guarded = nativeRecordWritePredicate(mod),
    boxedTypes: IrType[] = [];
  const value = (expr: IrExpr): boolean =>
    expr.kind !== "fieldAbsent" &&
    (expr.kind !== "ternary" || value(expr.then) || value(expr.else_));
  for (const fn of mod.functions)
    everyStmtList(fn.body, {
      expr: (expr) => {
        if (
          expr.kind === "intrinsic" &&
          expr.name === "native.checkWrite" &&
          expr.args.length === 4
        )
          boxedTypes.push(expr.args[0]!.type, expr.args[3]!.type);
        return true;
      },
      stmt: (stmt) => {
        if (
          guarded(stmt) &&
          (!stmt.propertyOp || stmt.propertyOp === "set" || stmt.propertyOp === "setSloppy") &&
          value(stmt.value)
        )
          boxedTypes.push(stmt.obj.type, stmt.value.type);
        return true;
      },
    });
  return {
    callsSetter: boxedTypes.length > 0,
    boxedTypes: [...new Map(boxedTypes.map((type) => [typeKey(type), type])).values()],
  };
}

/** Closed layouts can retain undeclared keys from a checked conversion. */
export function recordMayKeepSource(shape: IrRecordShape): boolean {
  return !shape.tuple && !shape.indexValue && shape.fields.length > 0;
}

/** Exposure can attach a dynamic metadata owner even to an empty record.
 * Decide before allocation so every alias agrees on collector headers. */
export function computeRecordMetadataShapes(
  mod: IrModule,
  exposed: NativeTypes | null = computeNativeIntegrityTypes(mod),
): Set<string> {
  return new Set(
    (mod.records ?? [])
      .filter(
        (shape) =>
          exposed?.records.has(shape.id) &&
          (recordMayKeepSource(shape) || nativeRecordIntegrityEligible(shape)),
      )
      .map((shape) => shape.id),
  );
}

/** Ordinary integrity is shallow, but any exposed child can independently
 * reach Object.freeze through a checked alias. These are possible referent
 * identities, not a deep-frozen set, and constructors get no exemption. */
export function computeNativeIntegrityTypes(mod: IrModule): NativeTypes | null {
  const roots: IrType[] = [];
  // The emitter registers every user Error view independently of explicit
  // dyn conversions. Catch bindings can expose its fields through that view.
  const children = new Map<string, IrClassDef[]>();
  for (const cls of mod.classes ?? []) {
    if (cls.base === undefined) continue;
    let list = children.get(cls.base);
    if (!list) children.set(cls.base, (list = []));
    list.push(cls);
  }
  const errors = [...(children.get("%Error") ?? [])];
  while (errors.length) {
    const cls = errors.pop()!;
    if (!cls.runtime) roots.push({ kind: "object", className: cls.name });
    errors.push(...(children.get(cls.name) ?? []));
  }
  const records = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const visit = (expr: IrExpr): boolean => {
    if (expr.kind === "dynFrom") roots.push(expr.value.type);
    else if (expr.kind === "dynCheck") roots.push(expr.type);
    else if (
      expr.kind === "intrinsic" &&
      [
        "native.freeze",
        "native.seal",
        "native.preventExtensions",
        "native.isFrozen",
        "native.isSealed",
        "native.isExtensible",
      ].includes(expr.name) &&
      expr.args[0]
    )
      roots.push(expr.args[0].type);
    else if (expr.kind === "libCall" && expr.fn === "fetch.streamFrom" && expr.args[0])
      roots.push(expr.args[0].type);
    else if (expr.kind === "recordKeyGet" && expr.type.kind === "dyn" && !expr.overflowOnly)
      for (const field of records.get(expr.shapeId)?.fields ?? []) roots.push(field.type);
    else if (expr.kind === "genResume") roots.push(expr.gen.type);
    else if (expr.kind === "yieldExpr" && expr.captureCompletion)
      roots.push(expr.type, expr.captureCompletion.returnType);
    return true;
  };
  for (const fn of mod.functions) {
    if (fn.generator) roots.push(fn.generator.yieldT, fn.generator.nextT, fn.returnType);
    everyStmtList(fn.body, { expr: visit, stmt: () => true });
  }
  if (roots.length === 0) return null;
  const out = new NativeTypes();
  reachNativeTypes(mod, roots, out, true);
  return out;
}
