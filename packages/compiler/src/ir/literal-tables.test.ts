import { expect, test } from "vitest";
import {
  arrayOf,
  BOOL,
  F64,
  mapOf,
  STRING,
  VOID,
  type IrExpr,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";
import { rollLiteralTables, TABLE_MIN_ROWS } from "./literal-tables.js";
import { validateModule } from "./validate.js";

const loc = { file: "literal-tables.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const neg = (value: number): IrExpr => ({
  kind: "unary",
  op: "-",
  operand: num(value),
  type: F64,
  loc,
});
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const flag = (value: boolean): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });
const list = (elems: IrExpr[], elem = elems[0]!.type): IrExpr => ({
  kind: "arrayLit",
  elems,
  type: arrayOf(elem),
  loc,
});

function moduleOf(table: IrExpr): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    globals: [{ id: "%g.table", name: "table", type: table.type, mutable: false }],
    functions: [
      {
        name: "main",
        params: [],
        returnType: VOID,
        locals: [],
        body: [{ kind: "assign", localId: "%g.table", value: table, loc }],
        loc,
      },
    ],
  };
}

/** The value the module's one assignment stores, by evaluating the nodes a
 * table and its rolled form are made of. */
function evaluate(mod: IrModule): unknown {
  const locals = new Map<string, unknown>();
  const expr = (e: IrExpr): unknown => {
    switch (e.kind) {
      case "numLit":
      case "strLit":
      case "boolLit":
        return e.value;
      case "unary":
        return -(expr(e.operand) as number);
      case "bin":
        if (e.op === "<") return (expr(e.left) as number) < (expr(e.right) as number);
        if (e.op === "+") return (expr(e.left) as number) + (expr(e.right) as number);
        if (e.op === "!==") return expr(e.left) !== expr(e.right);
        throw new Error(`operator ${e.op}`);
      case "arrayLit":
        return e.elems.map(expr);
      case "varRef":
        return locals.get(e.localId);
      case "constCell":
        return (e.numbers ?? e.strings!)[expr(e.index) as number];
      case "arrIntrinsic": {
        if (e.method !== "push") throw new Error(`method ${e.method}`);
        const values = e.args.map(expr);
        return (expr(e.receiver) as unknown[]).push(...values);
      }
      case "mapNew":
        return new Map((e.seed ?? []).map((pair) => [expr(pair.key), expr(pair.value)]));
      case "mapIntrinsic": {
        if (e.method !== "set") throw new Error(`method ${e.method}`);
        (expr(e.receiver) as Map<unknown, unknown>).set(expr(e.args[0]!), expr(e.args[1]!));
        return undefined;
      }
      case "recordLit":
        return new Map(e.fields.map((field) => [field.name, expr(field.value)]));
      case "seqExpr":
        e.stmts.forEach(stmt);
        return expr(e.result);
      default:
        throw new Error(`expression ${e.kind}`);
    }
  };
  const stmt = (s: IrStmt): void => {
    switch (s.kind) {
      case "varDecl":
        locals.set(s.localId, expr(s.init!));
        return;
      case "assign":
        locals.set(s.localId, expr(s.value));
        return;
      case "exprStmt":
        expr(s.expr);
        return;
      case "while":
        while (expr(s.cond) === true) s.body.forEach(stmt);
        return;
      case "recordKeySet":
        if (s.overflowOnly !== true) throw new Error("a keyed write that may name a field");
        (expr(s.obj) as Map<unknown, unknown>).set(expr(s.key), expr(s.value));
        return;
      default:
        throw new Error(`statement ${s.kind}`);
    }
  };
  mod.functions[0]!.body.forEach(stmt);
  return locals.get("%g.table");
}

const kinds = (mod: IrModule): string[] => {
  const value = (mod.functions[0]!.body[0] as IrStmt & { kind: "assign" }).value;
  return value.kind === "seqExpr" ? value.stmts.map((s) => s.kind) : [value.kind];
};

test("a run of rows with one skeleton is built by one loop over its constants", () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    list([str(`name-${i}`), str(i % 3 === 0 ? "" : `tag-${i % 7}`), str("same")]),
  );
  const mod = moduleOf(list(rows));
  expect(validateModule(mod)).toEqual([]);
  const before = structuredClone(mod);
  const rolled = rollLiteralTables(mod);
  expect(mod).toEqual(before);
  expect(validateModule(rolled)).toEqual([]);
  expect(kinds(rolled)).toEqual(["varDecl", "varDecl", "while"]);
  expect(rolled.functions[0]!.locals.map((l) => [l.id, l.mutable])).toEqual([
    ["%table.1", false],
    ["%tableRow.1", true],
  ]);
  expect(evaluate(rolled)).toEqual(evaluate(mod));
  // The constant every row shares stays a literal; the others are columns.
  const text = JSON.stringify(rolled.functions[0]!.body);
  expect(text.match(/"kind":"constCell"/g)).toHaveLength(2);
  expect(text.match(/"kind":"strLit","value":"same"/g)).toHaveLength(1);
});

test("numbers keep their sign and booleans their value", () => {
  const rows = Array.from({ length: 80 }, (_, i) =>
    list([i === 3 ? neg(0) : i % 2 === 0 ? num(i * 1.5) : neg(i), num(i === 9 ? 0 : 7)]),
  );
  const mod = moduleOf(list(rows));
  const rolled = rollLiteralTables(mod);
  expect(validateModule(rolled)).toEqual([]);
  const built = evaluate(rolled) as number[][];
  expect(built).toEqual(evaluate(mod));
  expect(Object.is(built[3]![0], -0)).toBe(true);
  expect(Object.is(built[9]![1], 0)).toBe(true);

  const flags = moduleOf(list(Array.from({ length: 70 }, (_, i) => flag(i % 3 === 0))));
  const rolledFlags = rollLiteralTables(flags);
  expect(validateModule(rolledFlags)).toEqual([]);
  expect(kinds(rolledFlags)).toEqual(["varDecl", "varDecl", "while"]);
  expect(evaluate(rolledFlags)).toEqual(evaluate(flags));
});

test("rows outside a run stay in their places", () => {
  const pair = (i: number): IrExpr => list([str(`a${i}`), str(`b${i}`)]);
  const single = (i: number): IrExpr => list([str(`c${i}`)]);
  const elems = [
    single(0),
    single(1),
    ...Array.from({ length: 70 }, (_, i) => pair(i)),
    single(2),
    ...Array.from({ length: 90 }, (_, i) => pair(100 + i)),
    ...Array.from({ length: 130 }, (_, i) => (i % 2 === 0 ? single(i) : pair(i))),
  ];
  const mod = moduleOf(list(elems));
  const rolled = rollLiteralTables(mod);
  expect(validateModule(rolled)).toEqual([]);
  // The prefix stays in the literal; the 130 mixed rows append in batches.
  expect(kinds(rolled)).toEqual([
    "varDecl",
    "varDecl",
    "while",
    "exprStmt",
    "varDecl",
    "while",
    "exprStmt",
    "exprStmt",
    "exprStmt",
  ]);
  expect(evaluate(rolled)).toEqual(evaluate(mod));
});

test.each([
  ["a table one row short of the threshold", TABLE_MIN_ROWS - 1, (i: number) => str(`s${i}`)],
  ["bare numbers, which the backend appends from the image", 300, (i: number) => num(i)],
  [
    "rows that read a binding",
    300,
    (i: number): IrExpr =>
      i === 0 ? str("s") : { kind: "varRef", localId: "%g.other", type: STRING, loc },
  ],
  ["a string with a lone surrogate in every row", 300, (i: number) => str(`\ud800${i}`)],
])("leaves %s alone", (_name, count, row) => {
  const mod = moduleOf(list(Array.from({ length: count }, (_, i) => row(i))));
  expect(rollLiteralTables(mod)).toBe(mod);
});

test("a literal with a spread is left alone", () => {
  const table = list(Array.from({ length: 100 }, (_, i) => str(`s${i}`)));
  (table as IrExpr & { kind: "arrayLit" }).spreads = [4];
  (table as IrExpr & { kind: "arrayLit" }).elems[4] = list([str("x")]);
  const mod = moduleOf(table);
  expect(rollLiteralTables(mod)).toBe(mod);
});

test("the seeds of a Map are set by one loop, in source order", () => {
  const seed = Array.from({ length: 150 }, (_, i) => ({
    key: str(i === 90 ? "key-3" : `key-${i}`),
    value: i % 2 === 0 ? num(i) : neg(i),
  }));
  const mod = moduleOf({ kind: "mapNew", seed, type: mapOf(STRING, F64), loc });
  expect(validateModule(mod)).toEqual([]);
  const rolled = rollLiteralTables(mod);
  expect(validateModule(rolled)).toEqual([]);
  expect(kinds(rolled)).toEqual(["varDecl", "varDecl", "while"]);
  const built = evaluate(rolled) as Map<string, number>;
  expect([...built]).toEqual([...(evaluate(mod) as Map<string, number>)]);
  // The repeated key keeps its first place and takes its last value.
  expect([...built.keys()][3]).toBe("key-3");
  expect(built.get("key-3")).toBe(90);
});

test("index-signature entries are written by one loop after the declared fields", () => {
  const shape: IrType = { kind: "record", shapeId: "codes" };
  const entries = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `code-${from + i}`,
      value: num(from + i),
      overflow: true as const,
    }));
  const table = (fields: { name: string; value: IrExpr; overflow?: true }[]): IrModule => ({
    ...moduleOf({ kind: "recordLit", fields, type: shape, loc }),
    records: [{ id: "codes", fields: [{ name: "size", type: F64 }], indexValue: F64 }],
  });
  const mod = table([{ name: "size", value: num(1) }, ...entries(0, 100)]);
  expect(validateModule(mod)).toEqual([]);
  const rolled = rollLiteralTables(mod);
  expect(validateModule(rolled)).toEqual([]);
  expect(kinds(rolled)).toEqual(["varDecl", "varDecl", "while"]);
  expect([...(evaluate(rolled) as Map<string, number>)]).toEqual([
    ...(evaluate(mod) as Map<string, number>),
  ]);
  // A declared field after the entries cannot be written by a statement
  // that only inserts: the literal stays whole.
  const late = table([...entries(0, 100), { name: "size", value: num(1) }]);
  expect(rollLiteralTables(late)).toBe(late);
});
