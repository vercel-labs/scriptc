import { expect, test } from "vitest";
import { hoistFinalFieldReads } from "./field-values.js";
import { analyzeFinalFields } from "./final-fields.js";
import {
  BOOL,
  F64,
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";

const loc = { file: "field-values.ts", start: 0, end: 0 };
const GRID: IrType = { kind: "object", className: "Grid" };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  loc,
  kind: "varRef",
  localId,
  type,
});
const field = (obj: string, name: string): IrExpr => ({
  loc,
  kind: "fieldGet",
  obj: ref(obj, GRID),
  className: "Grid",
  field: name,
  type: F64,
});
const lt = (left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op: "<",
  left,
  right,
  type: BOOL,
});
const loopReading = (...reads: IrExpr[]): IrStmt => ({
  loc,
  kind: "while",
  cond: lt(ref("i"), reads[0]!),
  body: reads.slice(1).map((expr) => ({ loc, kind: "exprStmt", expr })),
});
const set = (obj: string, name: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "fieldSet",
  obj: ref(obj, GRID),
  className: "Grid",
  field: name,
  value,
});
const method = (name: string, body: IrStmt[], extra: Partial<IrFunction> = {}): IrFunction => ({
  loc,
  name,
  params: [{ localId: "this", name: "this", type: GRID }],
  locals: [
    { id: "this", name: "this", type: GRID, mutable: false },
    { id: "i", name: "i", type: F64, mutable: true },
  ],
  returnType: VOID,
  body,
  ...extra,
});
const grid: IrClassDef = {
  name: "Grid",
  fields: [
    { name: "w", type: F64 },
    { name: "count", type: F64 },
    { name: "hits", type: F64 },
  ],
  methods: [],
} as unknown as IrClassDef;
const moduleOf = (functions: IrFunction[]): IrModule => ({
  irVersion: 17,
  sourceFile: "field-values.ts",
  entry: "%init",
  classes: [grid],
  functions: [
    method("%Grid.constructor", [
      set("this", "w", num(8)),
      set("this", "count", num(0)),
      set("this", "hits", num(0)),
    ]),
    ...functions,
  ],
});
const hoistedLocals = (mod: IrModule, name: string): string[] => {
  const before = mod.functions.find((f) => f.name === name)!;
  const after = hoistFinalFieldReads(mod).functions.find((f) => f.name === name)!;
  return after.locals.slice(before.locals.length).map((l) => l.id);
};

test("scalar final fields exclude fields written or updated outside their constructor", () => {
  const mod = moduleOf([
    method("%Grid.bump", [
      set("this", "count", num(1)),
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "fieldIncDec",
          op: "+",
          prefix: true,
          obj: ref("this", GRID),
          className: "Grid",
          field: "hits",
          fieldDyn: false,
          type: F64,
        },
      },
    ]),
  ]);
  const finals = analyzeFinalFields(mod, true);
  expect(["w", "count", "hits"].filter((f) => finals.isFinal("Grid", f))).toEqual(["w"]);
  // Reference-only analysis ignores scalar fields entirely.
  expect(analyzeFinalFields(mod).isFinal("Grid", "w")).toBe(false);
});

test("loops read a final field of a receiver once, before the loop", () => {
  const mod = moduleOf([
    method("%Grid.scan", [
      loopReading(field("this", "w"), field("this", "w"), field("this", "count")),
    ]),
    method("%Grid.bump", [set("this", "count", num(1))]),
  ]);
  const out = hoistFinalFieldReads(mod).functions.find((f) => f.name === "%Grid.scan")!;
  expect(out.locals.slice(-1)).toEqual([
    { id: "this.w%final", name: "w", type: F64, mutable: false },
  ]);
  const block = out.body[0]!;
  expect(block.kind).toBe("block");
  if (block.kind !== "block") return;
  expect(block.body[0]).toMatchObject({
    kind: "varDecl",
    localId: "this.w%final",
    init: { kind: "fieldGet", field: "w" },
  });
  const loop = block.body[1]!;
  if (loop.kind !== "while") throw new Error("expected the loop");
  expect(loop.cond).toMatchObject({ right: { kind: "varRef", localId: "this.w%final" } });
  // The written field keeps its per-use read.
  expect(loop.body[1]).toMatchObject({
    kind: "exprStmt",
    expr: { kind: "fieldGet", field: "count" },
  });
});

test("constructors, suspending functions and rebound receivers keep their reads", () => {
  const scan = [loopReading(field("this", "w"))];
  const rebinding: IrStmt[] = [
    { loc, kind: "assign", localId: "this", value: ref("this", GRID) },
    ...scan,
  ];
  const mod = moduleOf([
    method("%Grid.gen", scan, {
      generator: { yieldT: F64, nextT: F64, resultType: { kind: "record", shapeId: "%gen" } },
    }),
    method("%Grid.later", scan, { async: true }),
    method("%Grid.rebind", rebinding),
    method("%Grid.plain", [{ loc, kind: "exprStmt", expr: field("this", "w") }]),
  ]);
  for (const name of ["%Grid.gen", "%Grid.later", "%Grid.rebind", "%Grid.plain"])
    expect(hoistedLocals(mod, name)).toEqual([]);
  const ctor = moduleOf([]);
  ctor.functions[0] = method("%Grid.constructor", [set("this", "w", num(8)), ...scan]);
  expect(hoistedLocals(ctor, "%Grid.constructor")).toEqual([]);
});
