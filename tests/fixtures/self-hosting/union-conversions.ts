import { writeFileSync } from "node:fs";
import { BOOL, F64, STRING, UNDEFINED_T, VOID, typeEquals } from "../../../packages/compiler/src/ir/ir.js";
import type { IrClassDef, IrExpr, IrFunction, IrModule, IrRecordShape, IrStmt, IrType, IrUnionDef, SrcLoc } from "../../../packages/compiler/src/ir/ir.js";
import { IR_VERSION, serializeModule } from "../../../packages/compiler/src/ir/serialize.js";
import { assignLegacyTiers } from "../../../packages/compiler/src/ir/tiers.js";
import { buildUnionNarrow } from "../../../packages/compiler/src/frontend/lowering/union-narrow.js";
import { buildUnionRetag, planUnionRetag } from "../../../packages/compiler/src/frontend/lowering/union-retag.js";
import type { WidthLift } from "../../../packages/compiler/src/frontend/lowering/width-lift.js";

const loc: SrcLoc = { file: "native-union-conversions.ts", start: 0, end: 1 };
const records: IrRecordShape[] = [];
const unions: IrUnionDef[] = [];
const functions: IrFunction[] = [];
const body: IrStmt[] = [];
const main: IrFunction = { name: "main", params: [], returnType: VOID, locals: [], body, loc };

function recordType(shapeId: string): IrType { return { kind: "record", shapeId }; }
function unionType(unionId: string): IrType { return { kind: "union", unionId }; }
function variable(localId: string, type: IrType): IrExpr { return { kind: "varRef", localId, type, loc }; }
function string(value: string): IrExpr { return { kind: "strLit", value, type: STRING, loc }; }
function number(value: number): IrExpr { return { kind: "numLit", value, type: F64, loc }; }
function boolean(value: boolean): IrExpr { return { kind: "boolLit", value, type: BOOL, loc }; }
function unit(): IrExpr { return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc }; }
function shapeOf(id: string): IrRecordShape | undefined { return records.find((shape) => shape.id === id); }

// The production union planner delegates payload conversion to the width
// relation. These fixtures use the scalar-field subset so the generated
// retag stage can run independently of the still-incomplete whole Lowerer.
function widthLift(source: IrType, target: IrType): WidthLift | null {
  if (typeEquals(source, target)) return { how: "copy" };
  if (source.kind !== "record" || target.kind !== "record") return null;
  const from = shapeOf(source.shapeId), to = shapeOf(target.shapeId);
  if (!from || !to) return null;
  for (const field of to.fields) {
    const old = from.fields.find((candidate) => candidate.name === field.name);
    if (!old || !typeEquals(old.type, field.type)) return null;
  }
  return { how: "width" };
}

function applyLift(lift: WidthLift, value: IrExpr, target: IrType): IrExpr {
  if (lift.how === "copy") return value;
  if (lift.how !== "width" || value.type.kind !== "record" || target.kind !== "record") {
    throw new Error("unexpected payload conversion");
  }
  const from = value.type.shapeId;
  const shape = shapeOf(target.shapeId);
  if (!shape) throw new Error("missing shape");
  return {
    kind: "recordLit", type: target, loc,
    fields: shape.fields.map((field) => ({
      name: field.name,
      value: { kind: "recordGet", obj: value, shapeId: from, field: field.name, type: field.type, loc } as IrExpr,
    })),
  };
}

function print(label: string, value: IrExpr): IrStmt {
  return { kind: "exprStmt", expr: { kind: "intrinsic", name: "console.log", args: [string(label), value], type: VOID, loc }, loc };
}
function wrap(def: IrUnionDef, tag: number, value: IrExpr): IrExpr {
  return { kind: "unionWrap", unionId: def.id, tag, value, type: unionType(def.id), loc };
}
function caught(label: string, call: IrExpr): IrStmt {
  const id = `error.${main.locals.length}`;
  main.locals.push({ id, name: "error", type: { kind: "caught" }, mutable: false });
  const error: IrExpr = { kind: "caughtToDyn", value: variable(id, { kind: "caught" }), type: { kind: "dyn" }, loc };
  return {
    kind: "tryCatch", tryBody: [{ kind: "exprStmt", expr: call, loc }], catchLocalId: id,
    catchBody: [print(label, { kind: "libCall", fn: "dyn.toStringCoerce",
      args: [{ kind: "dynKeyGet", value: error, key: string("name"), type: { kind: "dyn" }, loc }], type: STRING, loc })],
    finallyBody: null, loc,
  };
}

function scenario(prefix: string, fieldType: IrType, left: string | number | boolean, right: string | number | boolean, identity = false): void {
  const src = `${prefix}0`, a = `${prefix}1`, b = `${prefix}2`;
  records.push(
    { id: src, fields: [{ name: "kind", type: fieldType }, { name: "left", type: F64 }, { name: "right", type: F64 }] },
    { id: a, fields: [{ name: "kind", type: fieldType }, { name: "left", type: F64 }] },
    { id: b, fields: [{ name: "kind", type: fieldType }, { name: "right", type: F64 }] },
  );
  const from: IrUnionDef = {
    id: `${prefix}from`, arms: [recordType(src), UNDEFINED_T],
    discriminant: { field: "kind", cases: [{ tag: 0, values: [left, right] }] },
  };
  const to: IrUnionDef = {
    id: `${prefix}to`, arms: [recordType(identity ? src : a), recordType(b), UNDEFINED_T],
    discriminant: { field: "kind", cases: [{ tag: 0, values: [left] }, { tag: 1, values: [right] }] },
  };
  // Multiple literals can select one destination. The emitted OR must
  // test all aliases before falling through to another layout or the trap.
  const literals: (string | number | boolean)[] = [left, right];
  if (fieldType.kind === "string") {
    from.discriminant!.cases[0]!.values.push("alias\u0000left");
    // Narrowed metadata can omit a literal while retaining the exact source
    // layout. The native planner must copy it without stealing width routes.
    if (!identity) to.discriminant!.cases[0]!.values.push("alias\u0000left");
    literals.push("alias\u0000left");
  }
  unions.push(from, to);
  const plan = planUnionRetag(from, to, shapeOf, widthLift);
  if (!plan || plan[0]!.kind !== "discriminant") throw new Error("missing split plan");
  const name = `${prefix}retag`;
  functions.push(buildUnionRetag(name, from, to, plan, loc, applyLift, () => "payload"));
  for (const literal of literals) {
    const kind = typeof literal === "string" ? string(literal) : typeof literal === "number" ? number(literal) : boolean(literal);
    const source: IrExpr = {
      kind: "recordLit", fields: [{ name: "kind", value: kind }, { name: "left", value: number(17) }, { name: "right", value: number(43) }],
      type: recordType(src), loc,
    };
    const id = `${prefix}.${main.locals.length}`;
    main.locals.push({ id, name: "converted", type: unionType(to.id), mutable: false });
    body.push({ kind: "varDecl", localId: id, init: { kind: "call", callee: name, args: [wrap(from, 0, source)], type: unionType(to.id), loc }, loc });
    const output = variable(id, unionType(to.id));
    for (let tag = 0; tag < 2; tag++) {
      const destination = to.arms[tag]!;
      if (destination.kind !== "record") throw new Error("bad destination");
      body.push({
        kind: "if", cond: { kind: "unionIsTag", unionId: to.id, tag, negated: false, value: output, type: BOOL, loc },
        then: [print(`${prefix}:${tag}`, {
          kind: "recordGet", shapeId: destination.shapeId, field: tag === 0 ? "left" : "right",
          obj: { kind: "unionNarrow", unionId: to.id, tag, value: output, type: destination, loc }, type: F64, loc,
        })], else_: null, loc,
      });
    }
  }
  const nullish: IrExpr = { kind: "call", callee: name, args: [wrap(from, 1, unit())], type: unionType(to.id), loc };
  body.push(print(`${prefix}:undefined`, { kind: "unionIsTag", unionId: to.id, tag: 2, negated: false, value: nullish, type: BOOL, loc }));

  // A lying discriminator must throw without reading a destination layout.
  if (fieldType.kind !== "bool") {
    const invalid: IrExpr = {
      kind: "recordLit", type: recordType(src), loc,
      fields: [{ name: "kind", value: fieldType.kind === "string" ? string("invalid") : number(987) },
        { name: "left", value: number(17) }, { name: "right", value: number(43) }],
    };
    body.push(caught(`${prefix}:invalid`, { kind: "call", callee: name, args: [wrap(from, 0, invalid)], type: unionType(to.id), loc }));
  }

  // Missing unit arms keep the established catchable narrowing behavior.
  const required: IrUnionDef = {
    id: `${prefix}required`, arms: to.arms.slice(0, 2), discriminant: to.discriminant!,
  };
  unions.push(required);
  const narrow = planUnionRetag(from, required, shapeOf, widthLift);
  if (!narrow) throw new Error("missing narrowing plan");
  const narrowName = `${prefix}narrow`;
  functions.push(buildUnionRetag(narrowName, from, required, narrow, loc, applyLift, () => "payload"));
  body.push(caught(`${prefix}:narrow`, { kind: "call", callee: narrowName, args: [wrap(from, 1, unit())], type: unionType(required.id), loc }));
}

scenario("s", STRING, "constructor", "__proto__");
scenario("n", F64, 0, -2.5);
scenario("b", BOOL, false, true);
scenario("i", STRING, "kept", "width", true);

// Large conversions exercise indexed identity lookup with the same semantic
// discriminants as small conversions. Reverse tags and execute every arm.
const largeFrom: IrUnionDef = { id: "large-from", arms: [], discriminant: { field: "kind", cases: [] } };
const largeTo: IrUnionDef = { id: "large-to", arms: [], discriminant: { field: "kind", cases: [] } };
for (let index = 0; index < 32; index++) {
  const shape = `large-${index}`;
  records.push({ id: shape, fields: [{ name: "kind", type: STRING }, { name: "value", type: F64 }] });
  largeFrom.arms.push(recordType(shape));
  largeFrom.discriminant!.cases.push({ tag: index, values: [shape] });
  largeTo.arms.unshift(recordType(shape));
  largeTo.discriminant!.cases.push({ tag: 31 - index, values: [shape] });
}
unions.push(largeFrom, largeTo);
const largePlan = planUnionRetag(largeFrom, largeTo, shapeOf, widthLift);
if (!largePlan) throw new Error("missing large conversion");
functions.push(buildUnionRetag("large-retag", largeFrom, largeTo, largePlan, loc, applyLift, () => "payload"));
for (let index = 0; index < largeFrom.arms.length; index++) {
  const type = largeFrom.arms[index]!;
  if (type.kind !== "record") throw new Error("bad large conversion source");
  const source: IrExpr = { kind: "recordLit", type, loc, fields: [
    { name: "kind", value: string(type.shapeId) }, { name: "value", value: number(index) },
  ] };
  const converted: IrExpr = { kind: "call", callee: "large-retag", args: [wrap(largeFrom, index, source)], type: unionType(largeTo.id), loc };
  body.push(print(`large:${index}`, {
    kind: "recordGet", obj: { kind: "unionNarrow", unionId: largeTo.id, tag: 31 - index, value: converted, type, loc },
    shapeId: type.shapeId, field: "value", type: F64, loc,
  }));
}

// The same native stage emits checked single-arm extraction and deferred
// scalar field reads. Wrong non-unit tags must never share a payload read.
const scalarUnion: IrUnionDef = { id: "scalar", arms: [BOOL, F64, STRING, UNDEFINED_T] };
unions.push(scalarUnion);
for (const target of [BOOL, F64, STRING]) {
  const name = `extract_${target.kind}`;
  const fn = buildUnionNarrow(name, scalarUnion, target, loc, (type) => type.kind);
  if (!fn) throw new Error("missing extraction");
  functions.push(fn);
  const tag = target.kind === "bool" ? 0 : target.kind === "f64" ? 1 : 2;
  const value = target.kind === "bool" ? boolean(true) : target.kind === "f64" ? number(37) : string("retained");
  body.push(print(name, { kind: "call", callee: name, args: [wrap(scalarUnion, tag, value)], type: target, loc }));
  body.push(caught(`${name}:undefined`, { kind: "call", callee: name, args: [wrap(scalarUnion, 3, unit())], type: target, loc }));
  const wrongTag = target.kind === "string" ? 0 : 2;
  body.push(caught(`${name}:wrong`, { kind: "call", callee: name,
    args: [wrap(scalarUnion, wrongTag, wrongTag === 0 ? boolean(false) : string("wrong"))], type: target, loc }));
  if (target.kind === "bool" || target.kind === "f64") {
    const defaultValue = target.kind === "bool" ? boolean(false) : number(Number.NaN);
    const deferredName = `deferred_${target.kind}`;
    const deferred = buildUnionNarrow(deferredName, scalarUnion, target, loc, (type) => type.kind, defaultValue);
    if (!deferred) throw new Error("missing deferred extraction");
    functions.push(deferred);
    body.push(print(deferredName, { kind: "call", callee: deferredName, args: [wrap(scalarUnion, 3, unit())], type: target, loc }));
    body.push(print(`${deferredName}:present`, { kind: "call", callee: deferredName,
      args: [wrap(scalarUnion, tag, value)], type: target, loc }));
    body.push(caught(`${deferredName}:wrong`, { kind: "call", callee: deferredName,
      args: [wrap(scalarUnion, 2, string("wrong"))], type: target, loc }));
  }
}
body.push({ kind: "return", value: null, loc });
functions.push(main);
// Register the same runtime hierarchy used by the frontend. Catching an
// object without its class metadata deliberately erases its readable fields.
const errorFields = [
  { name: "name", type: STRING }, { name: "message", type: STRING },
  { name: "%code", type: STRING }, { name: "%cause", type: { kind: "dyn" } as IrType },
  { name: "%causeEnumerable", type: BOOL },
  { name: "%messagePresent", type: BOOL },
];
const classes: IrClassDef[] = [
  { name: "%Error", runtime: true, fields: errorFields, loc },
  { name: "%TypeError", runtime: true, base: "%Error", fields: errorFields, loc },
];
const module: IrModule = { classes, irVersion: IR_VERSION, sourceFile: loc.file, entry: "main", records, unions, functions };
// Serialized IR carries each function's tier, as lowering assigns it.
assignLegacyTiers(module.functions);
writeFileSync(process.argv[2]!, serializeModule(module));
