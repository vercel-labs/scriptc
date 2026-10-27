import { expect, test } from "vitest";
import {
  F64,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "./ir.js";
import { resolveSelfCaptures } from "./self-captures.js";

const loc = { file: "self.ts", start: 0, end: 0 };
const FN = funcOf([], F64);
const ref = (localId: string, type = FN): IrExpr => ({ kind: "varRef", localId, type, loc });
const call = (localId: string): IrExpr => ({
  kind: "callValue",
  callee: ref(localId),
  args: [],
  type: F64,
  loc,
});
const self: IrExpr = { kind: "selfRef", type: FN, loc };
const closure = (fnName: string, captures: string[], extra: object = {}): IrExpr => ({
  kind: "closure",
  fnName,
  captures,
  type: FN,
  loc,
  ...extra,
});
const decl = (localId: string, init: IrExpr | null): IrStmt => ({
  kind: "varDecl",
  localId,
  init,
  loc,
});
const assign = (localId: string, value: IrExpr, initializes = false): IrStmt => ({
  kind: "assign",
  localId,
  value,
  ...(initializes ? { initializes: true as const } : {}),
  loc,
});
const ret = (e: IrExpr): IrStmt => ({ kind: "return", value: e, loc });
const use = (e: IrExpr): IrStmt => ({ kind: "exprStmt", expr: e, loc });
const local = (id: string, extra: Partial<IrLocal> = {}): IrLocal => ({
  id,
  name: id.split(".")[0]!,
  type: FN,
  mutable: false,
  boxed: true,
  ...extra,
});

function outer(body: IrStmt[], locals: IrLocal[]): IrFunction {
  return { name: "outer", params: [], returnType: F64, locals, body, loc };
}
function lifted(name: string, body: IrStmt[], captured: IrLocal[]): IrFunction {
  return {
    name,
    params: [],
    returnType: F64,
    captures: captured.map((l) => ({ localId: l.id, name: l.name, type: l.type })),
    locals: captured,
    body,
    loc,
  };
}
function run(...functions: IrFunction[]): Map<string, IrFunction> {
  const mod = { functions } as unknown as IrModule;
  return new Map(resolveSelfCaptures(mod).functions.map((fn) => [fn.name, fn]));
}

test("a closure stored in the dead-zone binding it captures reads itself", () => {
  const fns = run(
    outer(
      [decl("f.0", null), assign("f.0", closure("walk", ["f.0"]), true), ret(call("f.0"))],
      [local("f.0", { mutable: true, tdz: true })],
    ),
    lifted("walk", [ret(call("f.0"))], [local("f.0", { tdz: true })]),
  );
  const walk = fns.get("walk")!;
  expect(walk.captures).toEqual([]);
  expect(walk.locals).toEqual([]);
  expect(walk.body).toEqual([ret({ kind: "callValue", callee: self, args: [], type: F64, loc })]);
  const origin = fns.get("outer")!;
  expect(origin.body[1]).toEqual(assign("f.0", closure("walk", []), true));
  // The dead-zone box still represents the binding's uninitialized state.
  expect(origin.locals[0]).toMatchObject({ boxed: true, tdz: true });
});

test("a binding that only held the closure loses its box", () => {
  const n = local("n.0", { type: F64 });
  const fns = run(
    outer(
      [
        decl("n.0", { kind: "numLit", value: 1, type: F64, loc }),
        decl("f.0", closure("walk", ["n.0", "f.0"])),
        ret(call("f.0")),
      ],
      [n, local("f.0")],
    ),
    lifted("walk", [use(ref("n.0", F64)), ret(call("f.0"))], [n, local("f.0")]),
  );
  expect(fns.get("walk")!.captures!.map((c) => c.localId)).toEqual(["n.0"]);
  const origin = fns.get("outer")!;
  expect(origin.body[1]).toEqual(decl("f.0", closure("walk", ["n.0"])));
  expect(origin.locals.find((l) => l.id === "f.0")!.boxed).toBeUndefined();
  expect(origin.locals.find((l) => l.id === "n.0")!.boxed).toBe(true);
});

test("hoisted declarations qualify; later writes and second sites do not", () => {
  const body = (extra: IrStmt[]): IrStmt[] => [
    decl("f.0", null),
    assign("f.0", closure("walk", ["f.0"])),
    ...extra,
    ret(call("f.0")),
  ];
  const walk = lifted("walk", [ret(call("f.0"))], [local("f.0")]);
  const hoisted = run(outer(body([]), [local("f.0", { mutable: true })]), walk);
  expect(hoisted.get("walk")!.captures).toEqual([]);
  expect(hoisted.get("outer")!.locals[0]!.boxed).toBeUndefined();

  const rewritten = run(
    outer(body([assign("f.0", closure("other", []))]), [local("f.0", { mutable: true })]),
    walk,
    lifted("other", [ret({ kind: "numLit", value: 0, type: F64, loc })], []),
  );
  expect(rewritten.get("walk")).toBe(walk);

  // The same body stored somewhere else: its environment must keep the box.
  const elsewhere = run(
    outer(
      [...body([]).slice(0, 2), use(closure("walk", ["f.0"])), ret(call("f.0"))],
      [local("f.0", { mutable: true })],
    ),
    walk,
  );
  expect(elsewhere.get("walk")).toBe(walk);
});

test("an assignment in another statement list, an adapter or a nested capture keeps the box", () => {
  const walk = lifted("walk", [ret(call("f.0"))], [local("f.0")]);
  const branch = run(
    outer(
      [
        decl("f.0", null),
        { kind: "block", body: [assign("f.0", closure("walk", ["f.0"]))], loc },
        ret(call("f.0")),
      ],
      [local("f.0", { mutable: true })],
    ),
    walk,
  );
  expect(branch.get("walk")).toBe(walk);

  const adapter = run(
    outer(
      [decl("f.0", closure("walk", ["f.0"], { adapts: true })), ret(call("f.0"))],
      [local("f.0")],
    ),
    walk,
  );
  expect(adapter.get("walk")).toBe(walk);

  const nested = lifted("walk", [use(closure("inner", ["f.0"])), ret(call("f.0"))], [local("f.0")]);
  const recaptured = run(
    outer([decl("f.0", closure("walk", ["f.0"])), ret(call("f.0"))], [local("f.0")]),
    nested,
    lifted("inner", [ret(call("f.1"))], [local("f.1")]),
  );
  expect(recaptured.get("walk")).toBe(nested);
});

test("mutually recursive closures only drop their own capture", () => {
  const fns = run(
    outer(
      [
        decl("a.0", null),
        decl("b.0", null),
        assign("a.0", closure("fa", ["a.0", "b.0"]), true),
        assign("b.0", closure("fb", ["a.0", "b.0"]), true),
        ret(call("a.0")),
      ],
      [local("a.0", { mutable: true, tdz: true }), local("b.0", { mutable: true, tdz: true })],
    ),
    lifted(
      "fa",
      [use(call("b.0")), ret(call("a.0"))],
      [local("a.0", { tdz: true }), local("b.0", { tdz: true })],
    ),
    lifted(
      "fb",
      [use(call("a.0")), ret(call("b.0"))],
      [local("a.0", { tdz: true }), local("b.0", { tdz: true })],
    ),
  );
  expect(fns.get("fa")!.captures!.map((c) => c.localId)).toEqual(["b.0"]);
  expect(fns.get("fb")!.captures!.map((c) => c.localId)).toEqual(["a.0"]);
  expect(fns.get("outer")!.body.slice(2)).toEqual([
    assign("a.0", closure("fa", ["b.0"]), true),
    assign("b.0", closure("fb", ["a.0"]), true),
    ret(call("a.0")),
  ]);
});
