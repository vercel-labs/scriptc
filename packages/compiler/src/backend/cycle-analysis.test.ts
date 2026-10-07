import { expect, test } from "vitest";
import {
  DYN,
  F64,
  STRING,
  VOID,
  RUNTIME_EMITTER_CLASS,
  arrayOf,
  funcOf,
  mapOf,
  setOf,
  type IrModule,
  type IrRecordShape,
  type IrType,
} from "../ir/ir.js";
import { computeTraced } from "./cycle-analysis.js";
import { computeTraced as llvmTraced } from "./llvm/shapes.js";

const loc = { file: "cycles.ts", start: 0, end: 1 };
function module(): IrModule {
  return {
    irVersion: 14,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", locals: [], params: [], returnType: VOID, body: [], loc }],
  };
}
const ref = (shapeId: string): IrType => ({ kind: "record", shapeId });
const shape = (id: string, types: IrType[]): IrRecordShape => ({
  id,
  fields: types.map((type, i) => ({ name: `field${i}`, type })),
});

function check(mod: IrModule, shapes: string[], unions: string[] = []): void {
  const before = structuredClone(mod);
  const actual = computeTraced(mod);
  expect([...actual.shapes].sort()).toEqual(shapes.sort());
  expect([...actual.unions].sort()).toEqual(unions.sort());
  expect(llvmTraced(mod)).toEqual(actual);
  expect(mod).toEqual(before);
}

test("removes an entire acyclic dependency chain to a fixed point", () => {
  const mod = module();
  mod.records = [shape("a", [ref("b")]), shape("b", [ref("c")]), shape("c", [STRING, F64])];
  mod.unions = [{ id: "tail", arms: [ref("a"), { kind: "undefinedT" }] }];
  check(mod, []);
  mod.records.reverse();
  check(mod, []);
});

test("retains mutual cycles and every shape that can contain them", () => {
  const mod = module();
  mod.records = [
    shape("outer", [ref("a")]),
    shape("a", [ref("b")]),
    shape("b", [ref("a")]),
    shape("leaf", [F64]),
  ];
  check(mod, ["record:outer", "record:a", "record:b"]);
});

test("tracks cycles through unions, array elements and map values", () => {
  const mod = module();
  mod.records = [
    shape("node", [arrayOf(mapOf(STRING, { kind: "union", unionId: "link" }))]),
    shape("leaf", [STRING]),
  ];
  mod.unions = [
    { id: "link", arms: [ref("node"), { kind: "nullT" }] },
    { id: "leaf", arms: [ref("leaf"), F64] },
  ];
  check(mod, ["record:node"], ["link"]);
});

test("index-signature overflow participates in the same cycle graph", () => {
  const mod = module();
  mod.records = [
    { ...shape("recursive", []), indexValue: arrayOf(ref("recursive")) },
    { ...shape("scalar", []), indexValue: mapOf(STRING, F64) },
    { ...shape("promises", []), indexValue: { kind: "promise", inner: F64 } },
  ];
  check(mod, ["record:recursive", "record:promises"]);
});

test("closures and promises seed tracing even with scalar signatures", () => {
  const mod = module();
  mod.records = [
    shape("closure", [funcOf([], F64)]),
    shape("promise", [{ kind: "promise", inner: F64 }]),
    shape("bytes", [{ kind: "bytes", elem: "u8" }]),
  ];
  check(mod, ["record:closure", "record:promise"]);
});

test("a derived field requires a uniform header for the entire hierarchy", () => {
  const mod = module();
  mod.classes = [
    { name: "Derived", loc, base: "Base", fields: [{ name: "callback", type: funcOf([], VOID) }] },
    { name: "Sibling", loc, base: "Base", fields: [] },
    { name: "Base", loc, fields: [] },
    { name: "Independent", loc, fields: [{ name: "data", type: STRING }] },
  ];
  check(mod, ["object:Base", "object:Derived", "object:Sibling"]);
});

test("an acyclic hierarchy is removed as one unit", () => {
  const mod = module();
  mod.records = [shape("data", [F64])];
  mod.classes = [
    { name: "Derived", loc, base: "Base", fields: [{ name: "data", type: ref("data") }] },
    { name: "Base", loc, fields: [] },
  ];
  check(mod, []);
});

test("the runtime emitter and its descendants retain listener tracing", () => {
  const mod = module();
  mod.classes = [
    { name: "Events", loc, base: RUNTIME_EMITTER_CLASS, fields: [] },
    { name: RUNTIME_EMITTER_CLASS, loc, fields: [] },
  ];
  check(mod, ["object:Events", `object:${RUNTIME_EMITTER_CLASS}`]);
});

test("separate calls do not share mutable fixed-point state", () => {
  const mod = module();
  mod.records = [shape("same", [ref("same")])];
  const previous = computeTraced(mod);
  mod.records = [shape("same", [STRING])];
  check(mod, []);
  expect([...previous.shapes]).toEqual(["record:same"]);
});

test("map keys and set elements can close cycles without reference values", () => {
  const mod = module();
  mod.records = [
    shape("key", [mapOf(ref("key"), F64)]),
    shape("member", [setOf(ref("member"))]),
    shape("outer", [mapOf(ref("key"), STRING)]),
    shape("leaf", [F64]),
    shape("acyclic", [mapOf(ref("leaf"), STRING), setOf(ref("leaf"))]),
  ];
  check(mod, ["record:key", "record:member", "record:outer"]);
});

test("boxed keys and nested array elements retain cycle capability", () => {
  const mod = module();
  const key: IrType = { kind: "union", unionId: "key" };
  mod.records = [
    shape("node", [mapOf(key, F64)]),
    shape("list", [setOf(arrayOf(ref("list")))]),
    shape("leaf", [F64]),
  ];
  mod.unions = [{ id: "key", arms: [ref("node"), ref("leaf")] }];
  check(mod, ["record:node", "record:list"], ["key"]);
});

test("a map-key cycle in one subclass headers the whole hierarchy", () => {
  const mod = module();
  const base: IrType = { kind: "object", className: "Base" };
  mod.classes = [
    { name: "Base", fields: [], loc },
    { name: "Child", base: "Base", fields: [{ name: "owners", type: mapOf(base, F64) }], loc },
    { name: "Sibling", base: "Base", fields: [], loc },
  ];
  check(mod, ["object:Base", "object:Child", "object:Sibling"]);
});

test("checked values seed tracing through records and collections", () => {
  const mod = module();
  mod.records = [
    shape("value", [DYN]),
    shape("list", [arrayOf(DYN)]),
    shape("set", [setOf(DYN)]),
    shape("map", [mapOf(DYN, F64)]),
  ];
  check(mod, ["record:value", "record:list", "record:set", "record:map"]);
});

test("removes a long alternating shape/union chain regardless of definition order", () => {
  const mod = module();
  const size = 6000;
  mod.records = Array.from({ length: size }, (_, i) =>
    shape(`r${i}`, [
      arrayOf({ kind: "union", unionId: `u${i}` }),
      mapOf({ kind: "union", unionId: `u${i}` }, { kind: "union", unionId: `u${i}` }),
    ]),
  );
  mod.unions = Array.from({ length: size }, (_, i) => ({
    id: `u${i}`,
    arms: [i === size - 1 ? F64 : ref(`r${i + 1}`), STRING],
  }));
  check(mod, []);
  mod.records.reverse();
  mod.unions.reverse();
  check(mod, []);
});

test("removing one dependency keeps other branches, cycles, and intrinsic references", () => {
  const mod = module();
  mod.records = [
    shape("outer", [mapOf(ref("leaf"), ref("cycle"))]),
    shape("cycle", [ref("cycle"), ref("leaf")]),
    shape("leaf", [F64]),
    shape("intrinsic", [ref("leaf"), { kind: "caught" }]),
    shape("pruned", [mapOf(ref("leaf"), arrayOf(ref("leaf")))]),
  ];
  check(mod, ["record:outer", "record:cycle", "record:intrinsic"]);
});

test("hierarchies and unions participate in the same dependency graph", () => {
  const mod = module();
  mod.classes = [
    {
      name: "Child",
      base: "Base",
      fields: [{ name: "next", type: { kind: "union", unionId: "link" } }],
      loc,
    },
    { name: "Sibling", base: "Base", fields: [], loc },
    { name: "Base", fields: [], loc },
  ];
  mod.unions = [{ id: "link", arms: [{ kind: "object", className: "Sibling" }, F64] }];
  check(mod, ["object:Child", "object:Sibling", "object:Base"], ["link"]);
  mod.unions[0]!.arms = [F64, STRING];
  check(mod, []);
});

test("local class captures retain tracing even when the class has no fields", () => {
  const mod = module();
  mod.classes = [{ name: "Local", localCaptures: [], fields: [], loc }];
  check(mod, ["object:Local"]);
});

test("resolves a deep class hierarchy without recursive root traversal", () => {
  const mod = module();
  const size = 6000;
  mod.classes = Array.from({ length: size }, (_, i) => ({
    name: `C${i}`,
    ...(i === size - 1 ? {} : { base: `C${i + 1}` }),
    fields: [],
    loc,
  }));
  check(mod, []);
  mod.classes[0]!.fields = [{ name: "callback", type: funcOf([], VOID) }];
  check(
    mod,
    mod.classes.map((c) => `object:${c.name}`),
  );
});
