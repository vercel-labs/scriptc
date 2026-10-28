import { expect, test } from "vitest";
import { analyzeIntegerRangeFacts } from "./integer-ranges.js";
import { findLoopEntryVersions, LOOP_ENTRY_RANGE } from "./loop-entry-ranges.js";
import { BOOL, BYTES_U8, F64, type IrExpr, type IrFunction, type IrStmt } from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const bin = (op: "+" | "-" | "*" | "%", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: F64,
});
const condition = (op: "<" | "===", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: BOOL,
});
const set = (localId: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId, value });
const bump = (localId: string): IrStmt => ({
  loc,
  kind: "exprStmt",
  expr: { loc, kind: "incDec", op: "+", prefix: false, localId, type: F64 },
});
const observe = (value: IrExpr): IrStmt => ({ loc, kind: "exprStmt", expr: value });
const fn = (body: IrStmt[], locals: string[]): IrFunction => ({
  loc,
  name: "f",
  params: [],
  returnType: F64,
  locals: locals.map((id) => ({ id, name: id, type: F64, mutable: true })),
  body,
});

/** base = unknown; breaks = unknown; count = 0; i = 0;
 * while (i < 300) { ...extra; i++; count++; last = (count + base - breaks) % 8;
 *   if (last === 0) breaks++; }
 * observe(base) */
function lineBreaks(extra: IrStmt[] = [], locals: string[] = []) {
  const remainder = bin("%", bin("-", bin("+", ref("count"), ref("base")), ref("breaks")), num(8));
  const after = ref("base");
  const loop: IrStmt = {
    loc,
    kind: "while",
    cond: condition("<", ref("i"), num(300)),
    body: [
      ...extra,
      bump("i"),
      bump("count"),
      set("last", remainder),
      {
        loc,
        kind: "if",
        cond: condition("===", ref("last"), num(0)),
        then: [bump("breaks")],
        else_: null,
      },
    ],
  };
  const f = fn(
    [
      set("base", ref("unknown")),
      set("breaks", ref("unknown")),
      set("count", num(0)),
      set("i", num(0)),
      set("last", num(1)),
      loop,
      observe(after),
    ],
    ["base", "breaks", "count", "i", "last", ...locals],
  );
  return { f, loop, remainder, after };
}

test("versions a while loop whose remainder reads locals without entry facts", () => {
  const { f, loop, remainder } = lineBreaks();
  const facts = analyzeIntegerRangeFacts(f);
  expect(facts.ranges.get(remainder)).toBeFalsy();
  const version = findLoopEntryVersions(f, facts).get(loop);
  expect(version).toBeDefined();
  expect([...version!.entry]).toEqual([
    ["base", LOOP_ENTRY_RANGE],
    ["breaks", LOOP_ENTRY_RANGE],
  ]);
  // The dividend is an exact integer; `%` itself is modeled only for
  // non-negative dividends.
  const dividend = (remainder as Extract<IrExpr, { kind: "bin" }>).left;
  expect(version!.ranges.get(dividend)).toBeDefined();
  // The loop's counters, `breaks` among them, are bounded in the copy.
  expect(version!.loopRanges?.get("breaks")).toEqual({
    min: LOOP_ENTRY_RANGE.min,
    max: LOOP_ENTRY_RANGE.max + 300,
  });
});

test("the entry test covers only the locals the remainder depends on", () => {
  // acc = acc + scale reads two more locals without facts.
  const { f, loop } = lineBreaks(
    [set("acc", bin("+", ref("acc"), ref("scale")))],
    ["acc", "scale"],
  );
  f.body.unshift(set("acc", ref("unknown")), set("scale", ref("unknown")));
  const version = findLoopEntryVersions(f, analyzeIntegerRangeFacts(f)).get(loop);
  expect([...version!.entry.keys()]).toEqual(["base", "breaks"]);
});

test("assumed facts do not leave the loop", () => {
  const { f, loop, after } = lineBreaks();
  const assumed = new Map([[loop, new Map([["base", LOOP_ENTRY_RANGE]])]]);
  expect(analyzeIntegerRangeFacts(f, {}, assumed).ranges.get(after)).toBeFalsy();
});

test("loops without a remainder the assumption proves keep one copy", () => {
  // A local the loop makes fractional, a product without a remainder, and a
  // remainder the function already proves.
  const fractional = lineBreaks([set("base", bin("+", ref("base"), num(0.5)))]);
  expect(findLoopEntryVersions(fractional.f, analyzeIntegerRangeFacts(fractional.f)).size).toBe(0);
  const product: IrStmt = {
    loc,
    kind: "while",
    cond: condition("<", ref("i"), num(300)),
    body: [set("acc", bin("*", ref("acc"), ref("scale"))), bump("i")],
  };
  const products = fn(
    [set("acc", ref("unknown")), set("scale", ref("unknown")), set("i", num(0)), product],
    ["acc", "scale", "i"],
  );
  expect(findLoopEntryVersions(products, analyzeIntegerRangeFacts(products)).size).toBe(0);
  const proven: IrStmt = {
    loc,
    kind: "while",
    cond: condition("<", ref("i"), num(300)),
    body: [set("acc", bin("%", ref("i"), num(7))), bump("i")],
  };
  const known = fn([set("acc", ref("unknown")), set("i", num(0)), proven], ["acc", "i"]);
  expect(findLoopEntryVersions(known, analyzeIntegerRangeFacts(known)).size).toBe(0);
});

const step = (localId: string): IrExpr => ({
  loc,
  kind: "incDec",
  op: "+",
  prefix: false,
  localId,
  type: F64,
});
const bytes = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: BYTES_U8 });

/** i = unknown; o = unknown; line = unknown;
 * for (let j = 0; j < line; j = j + 1) out[o++] = src[i++];
 * observe(o) */
function cursors(init?: IrStmt) {
  const read: IrExpr = {
    loc,
    kind: "bytesIntrinsic",
    method: "get",
    receiver: bytes("src"),
    args: [step("i")],
    type: F64,
  };
  const store: IrStmt = { loc, kind: "bytesSet", arr: bytes("out"), index: step("o"), value: read };
  const loop: IrStmt = {
    loc,
    kind: "for",
    init: init ?? { loc, kind: "varDecl", localId: "j", init: num(0) },
    cond: condition("<", ref("j"), ref("line")),
    update: set("j", bin("+", ref("j"), num(1))),
    body: [store],
  };
  const after = ref("o");
  const f = fn(
    [
      set("i", ref("unknown")),
      set("o", ref("unknown")),
      set("line", ref("unknown")),
      loop,
      observe(after),
    ],
    ["i", "o", "line", "j", "unknown"],
  );
  f.locals.push(
    { id: "src", name: "src", type: BYTES_U8, mutable: false },
    { id: "out", name: "out", type: BYTES_U8, mutable: false },
  );
  return { f, loop, store, read, after };
}

test("versions a for loop on the positions it advances and the passes it runs", () => {
  const { f, loop, store, read, after } = cursors();
  const facts = analyzeIntegerRangeFacts(f);
  expect(facts.ranges.get((store as Extract<IrStmt, { kind: "bytesSet" }>).index)).toBeNull();
  const version = findLoopEntryVersions(f, facts).get(loop)!;
  expect([...version.entry.keys()].sort()).toEqual(["i", "line", "o"]);
  // Every pass advances each position once, and the passes stay below `line`.
  expect(version.loopRanges?.get("o")).toEqual({
    min: LOOP_ENTRY_RANGE.min,
    max: 2 * LOOP_ENTRY_RANGE.max,
  });
  expect(version.ranges.get((store as Extract<IrStmt, { kind: "bytesSet" }>).index)).toBeDefined();
  expect(
    version.ranges.get((read as Extract<IrExpr, { kind: "bytesIntrinsic" }>).args[0]!),
  ).toBeDefined();
  // No fact leaves the loop.
  expect(version.ranges.has(after)).toBe(false);
});

test("leaves a for loop whose initializer writes an advanced position as it is", () => {
  const init: IrStmt = { loc, kind: "assign", localId: "o", value: num(0) };
  const { f, loop } = cursors(init);
  expect(findLoopEntryVersions(f, analyzeIntegerRangeFacts(f)).has(loop)).toBe(false);
});
