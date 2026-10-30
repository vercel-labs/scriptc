import { expect, test } from "vitest";
import { F64, VOID, type IrExpr, type IrFunction, type IrStmt, type IrType } from "../../ir/ir.js";
import { analyzeWalks, findWalkBorrows, type WalkBorrowHost } from "./walk-borrows.js";

const loc = { file: "walk.ts", start: 0, end: 0 };
const NODE: IrType = { kind: "object", className: "Node" };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: NODE, loc });
const parent = (obj: IrExpr): IrExpr => ({
  kind: "fieldGet",
  obj,
  className: "Node",
  field: "parent",
  type: NODE,
  loc,
});
const decl = (localId: string, init: IrExpr | null): IrStmt => ({
  kind: "varDecl",
  localId,
  init,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const local = (id: string, mutable = true) => ({ id, name: id, type: NODE, mutable });

function fn(body: IrStmt[], locals: string[], params = ["node"]): IrFunction {
  return {
    name: "walk",
    params: params.map((id) => ({ localId: id, name: id, type: NODE })),
    locals: [...params, ...locals].map((id) => local(id)),
    body,
    returnType: VOID,
    loc,
  };
}

const host: WalkBorrowHost = {
  pointerLocal: (l) => l.type.kind === "object",
  borrowsWithoutOwning: () => true,
};

test("parent walks rooted at unwritten parameters borrow", () => {
  const body = [
    decl("p", parent(ref("node"))),
    decl("next", parent(ref("p"))),
    assign("p", ref("next")),
    decl("unset", null),
    assign("unset", parent(parent(ref("p")))),
  ];
  expect(findWalkBorrows(fn(body, ["p", "next", "unset"]), host)).toEqual(
    new Set(["p", "next", "unset"]),
  );
});

const call: IrExpr = { kind: "call", callee: "make", args: [], type: NODE, loc };

test("parameters rebound only to walks keep borrowing", () => {
  const body = [assign("node", parent(ref("node"))), decl("up", parent(ref("node")))];
  expect(findWalkBorrows(fn(body, ["up"]), host)).toEqual(new Set(["node", "up"]));
  // A parameter re-declared without an initializer is left alone.
  expect(findWalkBorrows(fn([decl("node", null)], []), host).size).toBe(0);
});

test("rebound parameters, owned sources and other writers keep ownership", () => {
  const body = [
    // A parameter rebound to an owned value is no root, and neither is its walk.
    assign("node", call),
    decl("fromParam", parent(ref("node"))),
    // A call result is owned, and the failure propagates transitively.
    decl("owned", call),
    decl("viaOwned", parent(ref("owned"))),
    decl("viaViaOwned", ref("viaOwned")),
    // An expression-position write excludes the local.
    decl("written", parent(ref("other"))),
    {
      kind: "exprStmt",
      expr: { kind: "assignExpr", localId: "written", value: ref("other"), type: NODE, loc },
      loc,
    } as IrStmt,
    decl("kept", parent(ref("other"))),
  ];
  const result = findWalkBorrows(
    fn(
      body,
      ["fromParam", "owned", "viaOwned", "viaViaOwned", "written", "kept"],
      ["node", "other"],
    ),
    host,
  );
  expect(result).toEqual(new Set(["kept"]));
});

test("scalar locals, owning projections and suspending bodies are never walks", () => {
  const scalar = fn([decl("p", parent(ref("node")))], ["p"]);
  scalar.locals[1] = { id: "p", name: "p", type: F64, mutable: true };
  expect(findWalkBorrows(scalar, host).size).toBe(0);
  const owning = fn([decl("p", parent(ref("node")))], ["p"]);
  expect(findWalkBorrows(owning, { ...host, borrowsWithoutOwning: () => false }).size).toBe(0);
  const suspending: IrFunction = { ...fn([decl("p", parent(ref("node")))], ["p"]), async: true };
  expect(findWalkBorrows(suspending, host).size).toBe(0);
});

test("returns of walks, including calls to borrowed-return callees, return borrowed", () => {
  const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });
  const accessor: IrExpr = { kind: "call", callee: "fileOf", args: [ref("node")], type: NODE, loc };
  const borrowedHost = { ...host, borrowedReturn: (callee: string) => callee === "fileOf" };
  const walking = fn([decl("p", accessor), ret(parent(ref("p")))], ["p"]);
  expect(analyzeWalks(walking, borrowedHost)).toEqual({
    locals: new Set(["p"]),
    returnsWalk: true,
  });
  // Without the callee fact the call result is owned.
  expect(analyzeWalks(walking, host)).toEqual({ locals: new Set(), returnsWalk: false });
  // Every return must walk, a try statement disqualifies, and parameters
  // outside the borrowing convention are no roots.
  const mixed = fn([ret(parent(ref("node"))), ret(call)], []);
  expect(analyzeWalks(mixed, borrowedHost).returnsWalk).toBe(false);
  const guarded = fn(
    [
      {
        kind: "tryCatch",
        tryBody: [ret(ref("node"))],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [],
        loc,
      },
    ],
    [],
  );
  expect(analyzeWalks(guarded, borrowedHost).returnsWalk).toBe(false);
  const owned = fn([ret(parent(ref("node")))], []);
  expect(analyzeWalks(owned, { ...borrowedHost, parameterAllowed: () => false }).returnsWalk).toBe(
    false,
  );
  expect(analyzeWalks(owned, borrowedHost).returnsWalk).toBe(true);
});

test("a string literal return keeps the body's other walks borrowed", () => {
  const ret = (value: IrExpr | null): IrStmt => ({ kind: "return", value, loc });
  const STRING: IrType = { kind: "string" };
  const text: IrExpr = {
    kind: "fieldGet",
    obj: ref("node"),
    className: "Node",
    field: "text",
    type: STRING,
    loc,
  };
  const empty: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const getter = fn([ret(text), ret(empty)], []);
  expect(analyzeWalks(getter, host).returnsWalk).toBe(true);
  // The literal needs no unwritten location; the field read still does.
  expect(analyzeWalks(getter, { ...host, unwritten: () => false }).returnsWalk).toBe(false);
  expect(analyzeWalks(fn([ret(empty)], []), { ...host, unwritten: () => false }).returnsWalk).toBe(
    true,
  );
});
