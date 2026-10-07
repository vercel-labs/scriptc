import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";
import { scalarizeNumericRecords } from "./scalar-records.js";
import { validateModule } from "./validate.js";

const loc = { file: "scalar-records.ts", start: 0, end: 0 };
const record: IrType = { kind: "record", shapeId: "r0" };
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const call = (callee: string, args: IrExpr[] = [], type: IrType = F64): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const read = (localId: string, field = "a"): IrExpr => ({
  kind: "recordGet",
  obj: ref(localId, record),
  shapeId: "r0",
  field,
  type: F64,
  loc,
});

function fixture(): IrModule {
  return {
    irVersion: 14,
    sourceFile: loc.file,
    entry: "main",
    records: [
      {
        id: "r0",
        fields: [
          { name: "a", type: F64 },
          { name: "b", type: F64 },
        ],
      },
    ],
    functions: [
      {
        name: "pair",
        params: [{ localId: "x", name: "x", type: F64 }],
        returnType: record,
        locals: [{ id: "x", name: "x", type: F64, mutable: true }],
        body: [
          {
            kind: "return",
            value: {
              kind: "recordLit",
              type: record,
              fields: [
                { name: "b", value: call("effect", [num(2)]) },
                { name: "a", value: ref("x") },
              ],
              loc,
            },
            loc,
          },
        ],
        loc,
      },
      {
        name: "effect",
        params: [{ localId: "x", name: "x", type: F64 }],
        returnType: F64,
        locals: [{ id: "x", name: "x", type: F64, mutable: true }],
        body: [{ kind: "return", value: ref("x"), loc }],
        loc,
      },
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [{ id: "result", name: "result", type: record, mutable: false }],
        body: [
          {
            kind: "varDecl",
            localId: "result",
            init: call("pair", [call("effect", [num(1)])], record),
            loc,
          },
          { kind: "exprStmt", expr: read("result"), loc },
        ],
        loc,
      },
    ],
  };
}

function nodes(value: unknown, kind: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((v) => nodes(v, kind));
  if (value === null || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [
    ...(node["kind"] === kind ? [node] : []),
    ...Object.entries(node).flatMap(([key, child]) =>
      key === "loc" || key === "type" ? [] : nodes(child, kind),
    ),
  ];
}

function main(mod: IrModule): IrFunction {
  return mod.functions.find((fn) => fn.name === "main")!;
}
function transformed(mod: IrModule): IrModule {
  expect(validateModule(mod)).toEqual([]);
  const out = scalarizeNumericRecords(mod);
  expect(validateModule(out)).toEqual([]);
  return out;
}

test("eliminates fresh field-only records without mutating input or dropping unused field effects", () => {
  const mod = fixture();
  const snapshot = structuredClone(mod);
  const out = transformed(mod);
  expect(mod).toEqual(snapshot);
  expect(out.functions[0]).toBe(mod.functions[0]);
  const caller = main(out);
  expect(nodes(caller.body, "recordGet")).toEqual([]);
  expect(caller.locals.every((local) => local.type.kind === "f64")).toBe(true);
  const calls = nodes(caller.body, "call");
  expect(calls.map((c) => c["callee"])).toEqual(["effect", "effect"]);
  expect(calls.map((c) => (c["args"] as IrExpr[])[0])).toEqual([num(1), num(2)]);
  const writes = nodes(caller.body, "assign");
  expect(writes.map((w) => caller.locals.find((l) => l.id === w["localId"])?.name)).toEqual([
    "result.b",
    "result.a",
  ]);
});

test("renames producer locals and labels at repeated calls inside caller control flow", () => {
  const mod = fixture();
  const producer = mod.functions[0]!;
  producer.locals.push({ id: "%scalar.0", name: "collision", type: F64, mutable: false });
  producer.body = [
    {
      kind: "block",
      labels: ["same", "%scalar.1"],
      body: [
        { kind: "varDecl", localId: "%scalar.0", init: num(9), loc },
        {
          kind: "if",
          cond: { kind: "boolLit", value: false, type: BOOL, loc },
          then: [{ kind: "break", label: "same", loc }],
          else_: null,
          loc,
        },
        ...producer.body,
      ],
      loc,
    },
    ...producer.body,
  ];
  const caller = main(mod);
  caller.locals.push({ id: "again", name: "again", type: record, mutable: false });
  caller.body.push(
    { kind: "varDecl", localId: "again", init: call("pair", [num(4)], record), loc },
    { kind: "exprStmt", expr: read("again"), loc },
  );
  caller.body = [{ kind: "block", labels: ["same"], body: caller.body, loc }];
  const out = main(transformed(mod));
  expect(nodes(out.body, "call").every((n) => n["callee"] !== "pair")).toBe(true);
  expect(new Set(out.locals.map((l) => l.id)).size).toBe(out.locals.length);
  expect(nodes(out.body, "recordGet")).toEqual([]);
});

test.each(["alias", "mutation", "identity", "return", "capture", "reassignment"])(
  "keeps objects observed through %s",
  (use) => {
    const mod = fixture();
    const caller = main(mod);
    if (use === "alias") {
      caller.locals.push({ id: "alias", name: "alias", type: record, mutable: false });
      caller.body.push({ kind: "varDecl", localId: "alias", init: ref("result", record), loc });
    } else if (use === "mutation") {
      caller.body.push({
        kind: "recordSet",
        obj: ref("result", record),
        shapeId: "r0",
        field: "a",
        value: num(7),
        loc,
      });
    } else if (use === "identity") {
      caller.body.push({
        kind: "exprStmt",
        expr: {
          kind: "bin",
          op: "===",
          left: ref("result", record),
          right: ref("result", record),
          type: BOOL,
          loc,
        },
        loc,
      });
    } else if (use === "return") {
      caller.returnType = record;
      caller.body.push({ kind: "return", value: ref("result", record), loc });
    } else if (use === "capture") {
      caller.locals[0]!.boxed = true;
    } else {
      caller.locals[0]!.mutable = true;
      caller.body.push({
        kind: "assign",
        localId: "result",
        value: call("pair", [num(7)], record),
        loc,
      });
    }
    expect(transformed(mod)).toBe(mod);
  },
);

test("keeps for-header declarations in their original IR form", () => {
  const mod = fixture();
  const caller = main(mod);
  caller.body = [
    {
      kind: "for",
      init: caller.body[0]!,
      cond: { kind: "boolLit", value: false, type: BOOL, loc },
      update: null,
      body: caller.body.slice(1),
      loc,
    },
  ];
  expect(transformed(mod)).toBe(mod);
});

test.each(["argument", "field"])(
  "retains reference temporaries in the original %s evaluation frame",
  (position) => {
    const mod = fixture();
    const length: IrExpr = {
      kind: "strIntrinsic",
      method: "length",
      receiver: { kind: "strLit", value: "abc", type: STRING, loc },
      args: [],
      type: F64,
      loc,
    };
    if (position === "argument") {
      (main(mod).body[0] as IrStmt & { kind: "varDecl" }).init = call("pair", [length], record);
    } else {
      const ret = mod.functions[0]!.body[0] as IrStmt & { kind: "return" };
      (ret.value as IrExpr & { kind: "recordLit" }).fields[0]!.value = length;
    }
    expect(transformed(mod)).toBe(mod);
  },
);

test("bounds expansion in callers with many eligible calls", () => {
  const mod = fixture();
  const caller = main(mod);
  caller.locals = [];
  caller.body = [];
  for (let i = 0; i < 300; i++) {
    const id = `result${i}`;
    caller.locals.push({ id, name: id, type: record, mutable: false });
    caller.body.push(
      { kind: "varDecl", localId: id, init: call("pair", [num(i)], record), loc },
      { kind: "exprStmt", expr: read(id), loc },
    );
  }
  const out = main(transformed(mod));
  const remaining = nodes(out.body, "call").filter((n) => n["callee"] === "pair").length;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(300);
});
