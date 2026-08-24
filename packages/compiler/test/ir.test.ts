import { expect, test } from "vitest";
import { validateModule } from "../src/ir/validate.js";
import { deserializeModule, serializeModule } from "../src/ir/serialize.js";
import { fibModule } from "./fixtures/fib-ir.js";
import { BOOL, F64, type IrModule } from "../src/ir/ir.js";

test("hand-built fib module validates", () => {
  expect(validateModule(fibModule)).toEqual([]);
});

test("validator rejects Date union arms unsupported by the backends", () => {
  const bad = structuredClone(fibModule);
  bad.unions = [{ id: "u-date", arms: [{ kind: "date" }, { kind: "undefinedT" }] }];
  expect(validateModule(bad).map((e) => e.message)).toContain("union u-date: arm 0 is date");
});

test("fib module JSON round-trips", () => {
  const json = serializeModule(fibModule);
  expect(deserializeModule(json)).toEqual(fibModule);
});

test("validator rejects type mismatches and bad references", () => {
  const loc = { file: "t.ts", start: 0, end: 0 };
  const bad: IrModule = {
    irVersion: 6,
    sourceFile: "t.ts",
    entry: "__main",
    functions: [
      {
        name: "__main",
        params: [],
        returnType: { kind: "void" },
        locals: [{ id: "x.0", name: "x", type: F64, mutable: false }],
        body: [
          // init type mismatch: bool into f64 local
          { kind: "varDecl", localId: "x.0", init: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
          // undeclared local
          { kind: "assign", localId: "y.0", value: { kind: "numLit", value: 1, type: F64, loc }, loc },
          // assign to immutable
          { kind: "assign", localId: "x.0", value: { kind: "numLit", value: 1, type: F64, loc }, loc },
          // call to unknown function
          { kind: "exprStmt", expr: { kind: "call", callee: "nope", args: [], type: F64, loc }, loc },
        ],
        loc,
      },
    ],
  };
  const errors = validateModule(bad).map((e) => e.message);
  expect(errors).toEqual([
    expect.stringContaining('init: expected f64, got bool'),
    expect.stringContaining('undeclared local/global "y.0"'),
    expect.stringContaining('immutable local "x"'),
    expect.stringContaining('undeclared function "nope"'),
  ]);
});

test("serializer round-trips ±Infinity and refuses NaN", () => {
  const mod = structuredClone(fibModule);
  const fn = mod.functions[0]!;
  const stmt = fn.body[0]!;
  if (stmt.kind === "if" && stmt.cond.kind === "bin" && stmt.cond.right.kind === "numLit") {
    stmt.cond.right.value = Infinity;
  }
  const back = deserializeModule(serializeModule(mod));
  const stmt2 = back.functions[0]!.body[0]!;
  if (stmt2.kind === "if" && stmt2.cond.kind === "bin" && stmt2.cond.right.kind === "numLit") {
    expect(stmt2.cond.right.value).toBe(Infinity);
  } else {
    throw new Error("round-trip lost the statement shape");
  }
  if (stmt.kind === "if" && stmt.cond.kind === "bin" && stmt.cond.right.kind === "numLit") {
    stmt.cond.right.value = -Infinity;
  }
  const back2 = deserializeModule(serializeModule(mod));
  const stmt3 = back2.functions[0]!.body[0]!;
  if (stmt3.kind === "if" && stmt3.cond.kind === "bin" && stmt3.cond.right.kind === "numLit") {
    expect(stmt3.cond.right.value).toBe(-Infinity);
  }
  if (stmt.kind === "if" && stmt.cond.kind === "bin" && stmt.cond.right.kind === "numLit") {
    stmt.cond.right.value = NaN;
  }
  expect(() => serializeModule(mod)).toThrow(/NaN/);
});

test("deserializer rejects the previous IR version", () => {
  const json = serializeModule(fibModule).replace('"irVersion": 6', '"irVersion": 5');
  expect(() => deserializeModule(json)).toThrow(/version mismatch/);
});

test("recordClone survives the IR JSON round trip", () => {
  const loc = { file: "clone.ts", start: 0, end: 1 };
  const type = { kind: "record", shapeId: "r0" } as const;
  const mod = structuredClone(fibModule);
  mod.records = [{
    id: "r0",
    fields: [{ name: "name", type: { kind: "string" } }],
  }];
  mod.functions[0]!.locals.push({ id: "source.0", name: "source", type, mutable: false });
  mod.functions[0]!.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "recordClone",
      source: { kind: "varRef", localId: "source.0", type, loc },
      overrides: [{ name: "name", value: { kind: "strLit", value: "next", type: { kind: "string" }, loc } }],
      type,
      loc,
    },
    loc,
  });
  expect(deserializeModule(serializeModule(mod))).toEqual(mod);
});

test("validator fences malformed recordClone nodes", () => {
  const loc = { file: "clone.ts", start: 0, end: 1 };
  const type = { kind: "record", shapeId: "r0" } as const;
  const mod = structuredClone(fibModule);
  mod.records = [{ id: "r0", fields: [{ name: "count", type: F64 }] }];
  mod.functions[0]!.locals.push({ id: "source.0", name: "source", type, mutable: false });
  mod.functions[0]!.body.unshift({
    kind: "exprStmt",
    expr: {
      kind: "recordClone",
      source: { kind: "varRef", localId: "source.0", type, loc },
      overrides: [
        { name: "missing", value: { kind: "numLit", value: 1, type: F64, loc } },
        { name: "missing", value: { kind: "numLit", value: 2, type: F64, loc } },
      ],
      type,
      loc,
    },
    loc,
  });
  expect(validateModule(mod).map((e) => e.message)).toEqual(expect.arrayContaining([
    expect.stringContaining('has no field "missing"'),
    expect.stringContaining('overrides field "missing" twice'),
  ]));
});
