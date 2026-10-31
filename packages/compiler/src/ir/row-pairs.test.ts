import { expect, test } from "vitest";
import { BOOL, F64, VOID, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";
import { pairRowSums } from "./row-pairs.js";

const loc = { file: "row-pairs.ts", start: 0, end: 0 };
const BYTES = { kind: "bytes", elem: "f64" } as const;
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const bytes = (localId: string): IrExpr & { kind: "varRef" } => ({
  loc,
  kind: "varRef",
  localId,
  type: BYTES,
});
const bin = (op: "+" | "/" | "<", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" ? BOOL : F64,
});
const step = (id: string): IrStmt => ({
  loc,
  kind: "assign",
  localId: id,
  value: bin("+", ref(id), num(1)),
});
const counted = (
  id: string,
  start: IrExpr,
  end: IrExpr,
  body: IrStmt[],
): IrStmt & { kind: "for" } => ({
  loc,
  kind: "for",
  init: { loc, kind: "varDecl", localId: id, init: start },
  cond: bin("<", ref(id), end),
  update: step(id),
  body,
});
const get = (array: string, index: IrExpr): IrExpr => ({
  loc,
  kind: "bytesIntrinsic",
  method: "get",
  receiver: bytes(array),
  args: [index],
  type: F64,
  invalidNaN: true,
});

/** for (i = start; i < end; i++) { t = 0; for (j = 0; j < n; j++) t += u[j] / (i + j + 1); v[i] = t } */
function rowSum(
  term: IrExpr = bin("/", get("u", ref("j")), bin("+", bin("+", ref("i"), ref("j")), num(1))),
) {
  return counted("i", ref("start"), ref("end"), [
    { loc, kind: "varDecl", localId: "t", init: num(0) },
    counted("j", num(0), ref("n"), [
      { loc, kind: "assign", localId: "t", value: bin("+", ref("t"), term) },
    ]),
    { loc, kind: "bytesSet", arr: bytes("v"), index: ref("i"), value: ref("t") },
  ]);
}

const local = (id: string, type: IrExpr["type"] = F64) => ({ id, name: id, type, mutable: true });
function mod(body: IrStmt[]): IrModule {
  const fn: IrFunction = {
    loc,
    name: "rows",
    params: [],
    locals: [
      ...["i", "j", "t", "start", "end", "n"].map((id) => local(id)),
      local("u", BYTES),
      local("v", BYTES),
    ],
    returnType: VOID,
    body,
  };
  return { irVersion: 17, sourceFile: "row-pairs.ts", entry: "rows", functions: [fn] };
}

test("a row-sum nest runs two rows per pass behind its bounds and overlap test", () => {
  const result = pairRowSums(mod([rowSum()]));
  const top = result.functions[0]!.body[0] as IrStmt & { kind: "block" };
  expect(top.kind).toBe("block");
  const [go, from, branch, rest] = top.body as [
    IrStmt & { kind: "varDecl" },
    IrStmt & { kind: "varDecl" },
    IrStmt & { kind: "if" },
    IrStmt & { kind: "for" },
  ];
  // The test: int32 bounds, start <= end, and the stored array disjoint
  // from the array the term reads.
  expect(JSON.stringify(go.init)).toContain('"fn":"bytes.disjoint"');
  expect(branch.else_).toBeNull();
  // The four bounds, masked to the range the test proved, then the pairs.
  expect(branch.then.slice(0, 4)).toMatchObject(
    Array(4).fill({ kind: "varDecl", init: { op: "&", right: { value: 2 ** 25 - 1 } } }),
  );
  const pairs = branch.then[4] as IrStmt & { kind: "for" };
  expect(pairs.body.filter((s) => s.kind === "bytesSet")).toHaveLength(2);
  const [, , inner, last] = pairs.body as [
    IrStmt,
    IrStmt,
    IrStmt & { kind: "for" },
    IrStmt & { kind: "if" },
  ];
  const column = inner.init as IrStmt & { kind: "varDecl" };
  // Two columns per step: for each, one read of u[j] for both rows, then
  // the two sums; the second column reads `column + 1`.
  expect(inner.body).toHaveLength(6);
  expect(inner.body[0]).toMatchObject({ kind: "varDecl", init: { kind: "bytesIntrinsic" } });
  expect(inner.body[3]).toMatchObject({
    kind: "varDecl",
    init: {
      kind: "bytesIntrinsic",
      args: [{ op: "+", left: { localId: column.localId }, right: { value: 1 } }],
    },
  });
  expect(inner.cond).toMatchObject({ op: "<", right: { op: "-", right: { value: 1 } } });
  expect(inner.update).toMatchObject({ value: { op: "+", right: { value: 2 } } });
  // The last column of an odd count, `to - 1`.
  expect(last.then).toHaveLength(3);
  expect(last.then[0]).toMatchObject({
    kind: "varDecl",
    init: { args: [{ op: "-", right: { value: 1 } }] },
  });
  expect(last.else_).toBeNull();
  // The second row's term reads `row + 1`.
  const row = pairs.init?.kind === "varDecl" ? pairs.init.localId : "";
  expect((inner.body[2] as IrStmt & { kind: "assign" }).value).toMatchObject({
    op: "+",
    right: {
      op: "/",
      left: { kind: "varRef" },
      right: {
        op: "+",
        left: {
          op: "+",
          left: { op: "+", left: { kind: "varRef", localId: row }, right: { value: 1 } },
        },
      },
    },
  });
  // The loop as written runs from `end - ((end - start) & 1)` after the
  // pairs, or from the start when the test failed: the nest's one other copy.
  expect(from.init).toMatchObject({
    kind: "ternary",
    then: { op: "-" },
    else_: { localId: "start" },
  });
  expect(rest.init).toMatchObject({
    kind: "varDecl",
    localId: "i",
    init: { localId: from.localId },
  });
  expect(top.body).toHaveLength(4);
  expect(
    result.functions[0]!.locals.map((l) => l.id).filter((id) => id.startsWith("%pair.")),
  ).toHaveLength(13);
});

test("nests whose term calls, writes or reads the sum keep their loops", () => {
  const calls: IrExpr = { loc, kind: "call", callee: "f", args: [ref("j")], type: F64 };
  const readsSum = bin("+", ref("t"), get("u", ref("j")));
  for (const term of [calls, readsSum]) {
    const m = mod([rowSum(term)]);
    expect(pairRowSums(m)).toBe(m);
  }
  const stored = rowSum();
  stored.body[2] = { loc, kind: "bytesSet", arr: bytes("v"), index: ref("j"), value: ref("t") };
  const m = mod([stored]);
  expect(pairRowSums(m)).toBe(m);
});
