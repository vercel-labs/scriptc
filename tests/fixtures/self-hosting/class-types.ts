import { F64, typeKey, type IrExpr, type IrModule, type IrRecordShape, type IrType, type IrUnionDef } from "../../../packages/compiler/src/ir/ir.js";
import { sanitizeUnregisteredClassTypes } from "../../../packages/compiler/src/frontend/lowering/sanitize-class-types.js";
import { UnregisteredClassTypes } from "../../../packages/compiler/src/frontend/lowering/unregistered-class-types.js";

const loc = { file: "class-types.ts", start: 0, end: 1 };
const missing: IrType = { kind: "object", className: "Fenced" };
const kept: IrType = { kind: "object", className: "Registered" };
const expr: IrExpr = { kind: "varRef", localId: "x", type: missing, loc };
const nested: IrType = { kind: "func", params: [{ kind: "array", elem: missing }],
  ret: { kind: "generator", yieldT: missing, retT: kept, nextT: missing } };
const module: IrModule = { irVersion: 14, sourceFile: loc.file, entry: "main",
  functions: [{ name: "main", params: [{ localId: "x", name: "x", type: missing }],
    returnType: nested, locals: [], loc, body: [{ kind: "exprStmt", expr, loc }] }],
  records: [{ id: "r", fields: [{ name: "callback", type: nested }], indexValue: missing }],
  unions: [{ id: "u", arms: [missing, kept, { kind: "classval", className: "Fenced" }] }],
};
sanitizeUnregisteredClassTypes(module, (name) => name === "Registered");
console.log(module.functions[0]!.params[0]!.type.kind, expr.type.kind);
console.log(typeKey(nested));
for (const record of module.records ?? []) {
  for (const field of record.fields) console.log(typeKey(field.type));
  if (record.indexValue) console.log(typeKey(record.indexValue));
}
for (const union of module.unions ?? []) console.log(union.arms.map(typeKey).join(","));
const records = new Map<string, IrRecordShape>();
const unions = new Map<string, IrUnionDef>();
for (let i = 0; i < 1024; i++) records.set(String(i), { id: String(i), fields: [
  { name: "next", type: { kind: "record", shapeId: String((i + 1) % 1024) } },
] });
let lookups = 0;
const references = new UnregisteredClassTypes(
  (id) => { lookups++; return records.get(id); }, (id) => unions.get(id), (name) => name === "Registered",
);
let bad = false;
for (let i = 0; i < 1024; i++) bad = references.has({ kind: "record", shapeId: String(i) }) || bad;
console.log(bad, lookups);
records.set("a", { id: "a", fields: [
  { name: "cycle", type: { kind: "record", shapeId: "b" } }, { name: "missing", type: missing },
] });
records.set("b", { id: "b", fields: [{ name: "back", type: { kind: "union", unionId: "u" } }] });
unions.set("u", { id: "u", arms: [{ kind: "record", shapeId: "a" }] });
const cyclic = new UnregisteredClassTypes((id) => records.get(id), (id) => unions.get(id), () => false);
console.log(cyclic.has({ kind: "record", shapeId: "a" }), cyclic.has({ kind: "record", shapeId: "b" }),
  cyclic.has({ kind: "union", unionId: "u" }), cyclic.has({ kind: "record", shapeId: "0" }));
console.log(missing.kind, kept.kind, F64.kind);
sanitizeUnregisteredClassTypes(module, (name) => name === "Registered");
console.log(expr.type.kind);
