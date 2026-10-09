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
  type IrExpr,
  type IrModule,
  type IrRecordShape,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";
import { computeTraced } from "./cycle-analysis.js";
import { computeTraced as llvmTraced } from "./llvm/shapes.js";

const loc = { file: "cycles.ts", start: 0, end: 1 };
function module(): IrModule {
  return {
    irVersion: 15,
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

/** Analyze `mod` exactly as given (its IR decides which edges are mutable). */
function checkExact(mod: IrModule, shapes: string[], unions: string[] = []): void {
  const before = structuredClone(mod);
  const actual = computeTraced(mod);
  expect([...actual.shapes].sort()).toEqual(shapes.sort());
  expect([...actual.unions].sort()).toEqual(unions.sort());
  expect(llvmTraced(mod)).toEqual(actual);
  expect(mod).toEqual(before);
}

const value = (type: IrType): IrExpr => ({ kind: "varRef", localId: "v", type, loc });
/** Writes to every field after construction, so every field edge is mutable. */
function writes(mod: IrModule): IrStmt[] {
  return [
    ...(mod.classes ?? []).flatMap((c) =>
      c.fields.map((f): IrStmt => ({
        kind: "fieldSet",
        obj: value({ kind: "object", className: c.name }),
        className: c.name,
        field: f.name,
        value: value(f.type),
        loc,
      })),
    ),
    ...(mod.records ?? []).flatMap((r) =>
      r.fields.map((f): IrStmt => ({
        kind: "recordSet",
        obj: value(ref(r.id)),
        shapeId: r.id,
        field: f.name,
        value: value(f.type),
        loc,
      })),
    ),
  ];
}

/** The mutable-graph contract: with every field written after
 * construction, capability is the plain reachability fixpoint. */
function withWrites(mod: IrModule): IrModule {
  const mutated = structuredClone(mod);
  mutated.functions[0]!.body.push(...writes(mutated));
  return mutated;
}
function check(mod: IrModule, shapes: string[], unions: string[] = []): void {
  checkExact(withWrites(mod), shapes, unions);
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
  const previous = computeTraced(withWrites(mod));
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

// ── immutable edges ────────────────────────────────────────────────────

const obj = (className: string): IrType => ({ kind: "object", className });
const link: IrType = { kind: "union", unionId: "link" };
const thisRef = (className: string): IrExpr => ({
  kind: "varRef",
  localId: "this.0",
  type: obj(className),
  loc,
});
function ctor(className: string, body: IrStmt[]): IrModule["functions"][number] {
  return {
    name: `%${className}.constructor`,
    params: [{ localId: "this.0", name: "this", type: obj(className) }],
    locals: [],
    returnType: VOID,
    body,
    loc,
  };
}
const setThis = (className: string, field: string, type: IrType): IrStmt => ({
  kind: "fieldSet",
  obj: thisRef(className),
  className,
  field,
  value: value(type),
  loc,
});
/** `class Tree { readonly left: Tree | null; readonly right: Tree | null }`. */
function tree(extra: IrStmt[] = []): IrModule {
  const mod = module();
  mod.classes = [
    {
      name: "Tree",
      fields: [
        { name: "left", type: link },
        { name: "right", type: link },
      ],
      loc,
    },
  ];
  mod.unions = [{ id: "link", arms: [obj("Tree"), { kind: "nullT" }] }];
  mod.functions.push(
    ctor("Tree", [setThis("Tree", "left", link), setThis("Tree", "right", link), ...extra]),
  );
  return mod;
}

test("constructor-only self references are acyclic", () => {
  checkExact(tree(), []);
  const record = module();
  record.records = [shape("list", [{ kind: "union", unionId: "next" }, F64])];
  record.unions = [{ id: "next", arms: [ref("list"), { kind: "nullT" }] }];
  checkExact(record, []);
});

test("a later write through any alias makes the edge mutable", () => {
  const mod = tree();
  mod.functions[0]!.body.push({
    kind: "fieldSet",
    obj: value(obj("Tree")),
    className: "Tree",
    field: "right",
    value: value(link),
    loc,
  });
  checkExact(mod, ["object:Tree"], ["link"]);
  const record = module();
  record.records = [shape("list", [ref("list")])];
  record.functions[0]!.body.push({
    kind: "recordKeySet",
    obj: value(ref("list")),
    shapeId: "list",
    key: value(STRING),
    value: value(ref("list")),
    loc,
  });
  checkExact(record, ["record:list"]);
});

test("field increments count as writes", () => {
  const mod = tree();
  mod.functions[0]!.body.push({
    kind: "exprStmt",
    expr: {
      kind: "fieldIncDec",
      op: "+",
      prefix: true,
      obj: value(obj("Tree")),
      className: "Tree",
      field: "left",
      fieldDyn: false,
      type: F64,
      loc,
    },
    loc,
  });
  checkExact(mod, ["object:Tree"], ["link"]);
});

test("this escaping from the constructor makes the hierarchy mutable", () => {
  const escape: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "call", callee: "register", args: [thisRef("Tree")], type: VOID, loc },
    loc,
  };
  checkExact(tree([escape]), ["object:Tree"], ["link"]);
  const capture: IrStmt = {
    kind: "varDecl",
    localId: "f.0",
    init: { kind: "closure", fnName: "%fn0", captures: ["this.0"], type: funcOf([], F64), loc },
    loc,
  };
  checkExact(tree([capture]), ["object:Tree"], ["link"]);
  const self: IrStmt = setThis("Tree", "left", link);
  (self as { value: IrExpr }).value = {
    kind: "unionWrap",
    unionId: "link",
    tag: 0,
    value: thisRef("Tree"),
    type: link,
    loc,
  };
  checkExact(tree([self]), ["object:Tree"], ["link"]);
});

test("field reads of this inside the constructor do not escape", () => {
  const read: IrStmt = {
    kind: "fieldSet",
    obj: thisRef("Tree"),
    className: "Tree",
    field: "left",
    value: {
      kind: "fieldGet",
      obj: thisRef("Tree"),
      className: "Tree",
      field: "right",
      type: link,
      loc,
    },
    loc,
  };
  checkExact(tree([read]), []);
});

test("derived constructors may initialize through super but not escape", () => {
  const mod = module();
  mod.classes = [
    { name: "Base", fields: [{ name: "next", type: link }], loc },
    {
      name: "Sub",
      base: "Base",
      fields: [
        { name: "next", type: link },
        { name: "other", type: link },
      ],
      loc,
    },
  ];
  mod.unions = [{ id: "link", arms: [obj("Base"), { kind: "nullT" }] }];
  const superCall: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: "%Base.constructor",
      args: [{ kind: "upcast", value: thisRef("Sub"), type: obj("Base"), loc }, value(link)],
      type: VOID,
      loc,
    },
    loc,
  };
  mod.functions.push(
    ctor("Base", [setThis("Base", "next", link)]),
    ctor("Sub", [superCall, setThis("Sub", "next", link), setThis("Sub", "other", link)]),
  );
  checkExact(mod, []);
  // Calling a constructor on anything but a derived constructor's own this.
  const reinit = structuredClone(mod);
  reinit.functions[0]!.body.push({
    kind: "exprStmt",
    expr: {
      kind: "call",
      callee: "%Base.constructor",
      args: [value(obj("Base")), value(link)],
      type: VOID,
      loc,
    },
    loc,
  });
  checkExact(reinit, ["object:Base", "object:Sub"], ["link"]);
  // A method of the subclass rewriting the inherited field.
  const method = structuredClone(mod);
  method.functions.push({
    name: "%Sub.relink",
    params: [{ localId: "this.0", name: "this", type: obj("Sub") }],
    locals: [],
    returnType: VOID,
    body: [setThis("Sub", "next", link)],
    loc,
  });
  checkExact(method, ["object:Base", "object:Sub"], ["link"]);
});

test("an immutable edge into a mutable cycle stays traced", () => {
  // X.holder is constructor-only; Holder.x is rewritten later: x -> h -> x.
  const mod = module();
  mod.classes = [
    { name: "X", fields: [{ name: "holder", type: obj("Holder") }], loc },
    { name: "Holder", fields: [{ name: "x", type: { kind: "union", unionId: "maybeX" } }], loc },
    { name: "Wrapper", fields: [{ name: "x", type: obj("X") }], loc },
  ];
  mod.unions = [{ id: "maybeX", arms: [obj("X"), { kind: "nullT" }] }];
  mod.functions.push(ctor("X", [setThis("X", "holder", obj("Holder"))]));
  mod.functions[0]!.body.push({
    kind: "fieldSet",
    obj: value(obj("Holder")),
    className: "Holder",
    field: "x",
    value: value({ kind: "union", unionId: "maybeX" }),
    loc,
  });
  checkExact(mod, ["object:X", "object:Holder", "object:Wrapper"], ["maybeX"]);
});

test("collection edges are mutable even behind constructor-only fields", () => {
  const mod = module();
  mod.classes = [{ name: "Call", fields: [{ name: "args", type: arrayOf(obj("Call")) }], loc }];
  mod.functions.push(ctor("Call", [setThis("Call", "args", arrayOf(obj("Call")))]));
  checkExact(mod, ["object:Call"]);
});

test("types that can become checked-dynamic capsules are mutable", () => {
  const toDyn: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "dynFrom", value: value(obj("Tree")), type: DYN, loc },
    loc,
  };
  checkExact(tree([toDyn]), ["object:Tree"], ["link"]);
  const thrown: IrStmt = { kind: "throw", value: value(link), loc };
  checkExact(tree([thrown]), ["object:Tree"], ["link"]);
  // Reached only through a boxed closure signature and a record field.
  const holder = tree();
  holder.records = [shape("box", [obj("Tree")])];
  holder.functions[0]!.body.push({
    kind: "exprStmt",
    expr: { kind: "dynFrom", value: value(funcOf([], ref("box"))), type: DYN, loc },
    loc,
  });
  checkExact(holder, ["object:Tree", "record:box"], ["link"]);
  const logged = tree();
  logged.functions[0]!.body.push({
    kind: "exprStmt",
    expr: { kind: "jsonStringify", value: value(arrayOf(link)), type: STRING, loc },
    loc,
  });
  checkExact(logged, ["object:Tree"], ["link"]);
});

test("library builds keep the mutable-graph analysis", () => {
  const mod = tree();
  mod.lib = {} as NonNullable<IrModule["lib"]>;
  checkExact(mod, ["object:Tree"], ["link"]);
});
