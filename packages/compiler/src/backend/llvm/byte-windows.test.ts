import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { analyzeIntegerRanges } from "../../ir/integer-ranges.js";
import { matchIntegerCountedForLoop } from "../../ir/integer-loops.js";
import { findInitializedByteLoopBindings, matchByteWindow } from "./byte-windows.js";

const loc = { file: "windows.ts", start: 0, end: 0 };
const bytes = { kind: "bytes", elem: "u8" } as const;
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrExpr["type"] = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const add = (left: IrExpr, value: number): IrExpr => ({
  kind: "bin",
  op: "+",
  left,
  right: num(value),
  type: F64,
  loc,
});
const read = (index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "readNum",
  receiver: ref("input", bytes),
  args: [{ kind: "strLit", value: "u32le", type: { kind: "string" }, loc }, index],
  type: F64,
  loc,
});
const write = (index: IrExpr): IrStmt => ({
  kind: "exprStmt",
  expr: {
    kind: "bytesIntrinsic",
    method: "writeNum",
    receiver: ref("output", bytes),
    args: [{ kind: "strLit", value: "u32be", type: { kind: "string" }, loc }, num(1), index],
    type: F64,
    loc,
  },
  loc,
});
const expression = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const advance = (value: number): IrStmt => ({
  kind: "assign",
  localId: "position",
  value: add(ref("position"), value),
  loc,
});
function fixture(): { fn: IrFunction; loop: IrStmt & { kind: "for" } } {
  const loop: IrStmt & { kind: "for" } = {
    kind: "for",
    init: { kind: "varDecl", localId: "offset", init: num(0), loc },
    cond: {
      kind: "bin",
      op: "<",
      left: ref("offset"),
      right: {
        kind: "bytesIntrinsic",
        method: "length",
        receiver: ref("input", bytes),
        args: [],
        type: F64,
        loc,
      },
      type: BOOL,
      loc,
    },
    update: { kind: "assign", localId: "offset", value: add(ref("offset"), 8), loc },
    body: [
      expression(read(ref("offset"))),
      expression(read(add(ref("offset"), 4))),
      write(ref("position")),
      advance(4),
    ],
    loc,
  };
  const locals: IrLocal[] = ["input", "output", "position", "offset", "alias"].map((id) => ({
    id,
    name: id,
    type: id === "input" || id === "output" ? bytes : F64,
    mutable: id !== "alias",
  }));
  return {
    loop,
    fn: {
      name: "window",
      params: ["input", "output"].map((id) => ({ localId: id, name: id, type: bytes })),
      returnType: VOID,
      locals,
      body: [{ kind: "varDecl", localId: "position", init: num(0), loc }, loop],
      loc,
    },
  };
}
function match(fn: IrFunction, loop: IrStmt & { kind: "for" }) {
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const ranges = analyzeIntegerRanges(fn);
  const counted = matchIntegerCountedForLoop(loop, locals, ranges);
  if (!counted) return null;
  return matchByteWindow(
    loop,
    counted,
    locals,
    new Set((fn.captures ?? []).map((c) => c.localId)),
    ranges,
    findInitializedByteLoopBindings(fn).get(loop) ?? new Set(),
  );
}

test("proves complete input fields and a filtered output cursor without changing global facts", () => {
  const { fn, loop } = fixture();
  const ranges = analyzeIntegerRanges(fn),
    before = [...ranges];
  const locals = new Map(fn.locals.map((l) => [l.id, l]));
  const window = matchByteWindow(
    loop,
    matchIntegerCountedForLoop(loop, locals, ranges)!,
    locals,
    new Set(),
    ranges,
    new Set(["input", "output", "position"]),
  );
  expect(window?.bounds.size).toBe(3);
  expect(window?.targets.map((t) => t.stride)).toEqual([4]);
  expect([...ranges]).toEqual(before);
  const access = (loop.body[1] as IrStmt & { kind: "exprStmt" }).expr;
  expect(access.kind).toBe("bytesIntrinsic");
  if (access.kind === "bytesIntrinsic")
    expect(window?.ranges.get(access.args[1]!)).toEqual({
      min: 4,
      max: Number.MAX_SAFE_INTEGER - 4,
    });
});

test("includes progress before each field and conservatively sums alternative branches", () => {
  const { fn, loop } = fixture();
  loop.body.splice(2, 0, {
    kind: "if",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    then: [advance(4)],
    else_: [advance(8)],
    loc,
  });
  expect(match(fn, loop)?.targets.map((t) => t.stride)).toEqual([16]);
  loop.body.push(advance(-4));
  expect(match(fn, loop)?.targets).toEqual([]);
});

test("follows immutable offset aliases and refuses mutated, captured or cyclic aliases", () => {
  const { fn, loop } = fixture();
  loop.body.splice(
    1,
    1,
    { kind: "varDecl", localId: "alias", init: add(ref("offset"), 4), loc },
    expression(read(ref("alias"))),
  );
  expect(match(fn, loop)?.bounds.size).toBe(3);
  fn.captures = [{ localId: "alias", name: "alias", type: F64 }];
  expect(match(fn, loop)).toBeNull();
  delete fn.captures;
  loop.body.push({ kind: "assign", localId: "alias", value: num(0), loc });
  expect(match(fn, loop)).toBeNull();
  loop.body.pop();
  (loop.body[1] as IrStmt & { kind: "varDecl" }).init = ref("alias");
  expect(match(fn, loop)).toBeNull();
});

test("does not hoist uninitialized receivers or borrow cursor proofs across expression writes", () => {
  const { fn, loop } = fixture();
  fn.params = fn.params.filter((p) => p.localId !== "output");
  fn.body.unshift({ kind: "varDecl", localId: "output", init: null, loc });
  expect(match(fn, loop)?.targets).toEqual([]);
  fn.body[0] = { kind: "assign", localId: "output", value: ref("input", bytes), loc };
  expect(match(fn, loop)?.targets).toHaveLength(1);
  loop.body.push(
    expression({
      kind: "assignExpr",
      localId: "position",
      value: add(ref("position"), 4),
      type: F64,
      loc,
    }),
  );
  expect(match(fn, loop)?.targets).toEqual([]);
});

test("rejects receiver changes, opaque bodies and oversized duplication", () => {
  for (const extra of [
    { kind: "assign", localId: "input", value: ref("output", bytes), loc },
    { kind: "while", cond: { kind: "boolLit", value: false, type: BOOL, loc }, body: [], loc },
    expression({ kind: "call", callee: "opaque", args: [], type: F64, loc }),
  ] as IrStmt[]) {
    const { fn, loop } = fixture();
    loop.body.push(extra);
    expect(match(fn, loop)).toBeNull();
  }
  const { fn, loop } = fixture();
  loop.body.push(...Array.from({ length: 160 }, () => expression(num(0))));
  expect(match(fn, loop)).toBeNull();
});

test("does not treat cancellation of rounded intermediate offsets as an affine field", () => {
  const { fn, loop } = fixture();
  const rounded = add(
    add(add(ref("offset"), Number.MAX_SAFE_INTEGER), -Number.MAX_SAFE_INTEGER),
    4,
  );
  loop.body[1] = expression(read(rounded));
  expect(match(fn, loop)).toBeNull();
});

test("initialization must dominate the loop on both branch paths", () => {
  const { fn, loop } = fixture();
  fn.params = fn.params.filter((p) => p.localId !== "output");
  const initialize: IrStmt = { kind: "assign", localId: "output", value: ref("input", bytes), loc };
  const branch: IrStmt & { kind: "if" } = {
    kind: "if",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    then: [initialize],
    else_: [],
    loc,
  };
  fn.body.splice(1, 0, branch);
  expect(match(fn, loop)?.targets).toEqual([]);
  branch.else_ = [initialize];
  expect(match(fn, loop)?.targets).toHaveLength(1);
});

test("keeps receiver/cursor pairs distinct when IR identifiers contain separators", () => {
  const { fn, loop } = fixture();
  const rename = (id: string): string => (id === "output" ? "a:b" : id === "position" ? "c" : id);
  for (const local of fn.locals) local.id = rename(local.id);
  for (const param of fn.params) param.localId = rename(param.localId);
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "varRef" || e.kind === "assignExpr" || e.kind === "incDec")
        e.localId = rename(e.localId);
      return true;
    },
    stmt: (s) => {
      if (s.kind === "assign" || s.kind === "varDecl") s.localId = rename(s.localId);
      return true;
    },
  });
  fn.params.push({ localId: "a", name: "second", type: bytes });
  fn.locals.push(
    { id: "a", name: "second", type: bytes, mutable: false },
    { id: "b:c", name: "secondary", type: F64, mutable: true },
  );
  fn.body.unshift({ kind: "varDecl", localId: "b:c", init: num(0), loc });
  loop.body.push(
    {
      kind: "exprStmt",
      expr: {
        kind: "bytesIntrinsic",
        method: "writeNum",
        receiver: ref("a", bytes),
        args: [
          { kind: "strLit", value: "u32be", type: { kind: "string" }, loc },
          num(1),
          ref("b:c"),
        ],
        type: F64,
        loc,
      },
      loc,
    },
    { kind: "assign", localId: "b:c", value: add(ref("b:c"), 4), loc },
  );
  const window = match(fn, loop);
  expect(
    window?.targets.map((t) =>
      t.receiver.kind === "varRef" ? [t.receiver.localId, t.cursor.localId] : null,
    ),
  ).toEqual([
    ["a:b", "c"],
    ["a", "b:c"],
  ]);
  expect(window?.bounds.size).toBe(4);
});
