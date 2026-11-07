import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrGlobal,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";
import { deferClosedInitializers, type LazyInitializerVerdict } from "./lazy-initializers.js";

const loc = { file: "program.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const call = (callee: string, args: IrExpr[] = [], type: IrType = VOID): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const run = (callee: string): IrStmt => ({ kind: "exprStmt", expr: call(callee), loc });
const add = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op: "+",
  left,
  right,
  type: F64,
  loc,
});
const when = (cond: IrExpr, then: IrStmt[], else_: IrStmt[] | null = null): IrStmt => ({
  kind: "if",
  cond,
  then,
  else_,
  loc,
});
const fn = (name: string, body: IrStmt[], returnType: IrType = VOID): IrFunction => ({
  name,
  params: [],
  returnType,
  locals: [],
  body,
  loc,
});
const global = (id: string, type: IrType = F64, mutable = false): IrGlobal => ({
  id,
  name: id.slice(id.lastIndexOf(".") + 1),
  type,
  mutable,
});
const loaded = (n: number): string => `%g.m${n}.%loaded`;
/** Module `n`'s initializer: the run-once guard, its imports, its body. */
const init = (n: number, imports: number[], body: IrStmt[]): IrFunction =>
  fn(`%init.${n}`, [
    when(ref(loaded(n), BOOL), [{ kind: "return", value: null, loc }]),
    assign(loaded(n), { kind: "boolLit", value: true, type: BOOL, loc }),
    ...imports.map((dep) => run(`%init.${dep}`)),
    ...body,
  ]);
/** The entry's initializer: its imports and its body, no guard. */
const entry = (imports: number[], body: IrStmt[]): IrFunction =>
  fn("%init.0", [...imports.map((dep) => run(`%init.${dep}`)), ...body]);
/** `seven()`: a function that only computes. */
const seven = fn("seven", [{ kind: "return", value: num(7), loc }], F64);
/** A truth the compiler does not know. */
const unknown: IrExpr = ref("%g.e.flag", BOOL);

function program(functions: IrFunction[], globals: IrGlobal[]): IrModule {
  const modules = functions
    .filter((f) => f.name.startsWith("%init.") && f.name !== "%init.0")
    .map((f) => Number(f.name.slice(6)));
  return {
    irVersion: 17,
    sourceFile: "program.ts",
    functions: [fn("%main", [run("%init.0")]), ...functions],
    globals: [
      ...globals,
      global("%g.e.flag", BOOL, true),
      ...modules.map((n) => global(loaded(n), BOOL, true)),
    ],
    entry: "%main",
  };
}
function defer(mod: IrModule): { out: IrModule; verdicts: Map<string, LazyInitializerVerdict> } {
  const verdicts = new Map<string, LazyInitializerVerdict>();
  const out = deferClosedInitializers(mod, undefined, (v) => verdicts.set(v.init, v));
  return { out, verdicts };
}
const named = (mod: IrModule, name: string): IrFunction =>
  mod.functions.find((f) => f.name === name)!;
/** `if (!%g.%lazy.N) %lazy.N();` */
const guardOf = (stmt: IrStmt | undefined): string | null =>
  stmt?.kind === "if" &&
  stmt.cond.kind === "unary" &&
  stmt.cond.operand.kind === "varRef" &&
  stmt.then.length === 1 &&
  stmt.then[0]!.kind === "exprStmt" &&
  stmt.then[0]!.expr.kind === "call"
    ? `${stmt.cond.operand.localId} ${stmt.then[0]!.expr.callee}`
    : null;
const callees = (f: IrFunction): string[] =>
  f.body.flatMap((s) => (s.kind === "exprStmt" && s.expr.kind === "call" ? [s.expr.callee] : []));

test("a module that only computes runs at the first use of what it makes", () => {
  const mod = program(
    [
      seven,
      init(1, [], [assign("%g.m1.table", call("seven", [], F64))]),
      fn("use", [{ kind: "return", value: add(ref("%g.m1.table"), num(1)), loc }], F64),
      entry([1], [when(unknown, [{ kind: "exprStmt", expr: call("use", [], F64), loc }])]),
    ],
    [global("%g.m1.table")],
  );
  const { out, verdicts } = defer(mod);
  expect(verdicts.get("%init.1")).toEqual({ init: "%init.1", group: "%lazy.0" });
  // The importer goes to the module's place instead of running it.
  expect(callees(named(out, "%init.0"))).toEqual(["%lazy.at.1"]);
  // The reader runs the group before the statement that reads.
  const use = named(out, "use");
  expect(use.body.map((s) => s.kind)).toEqual(["if", "return"]);
  expect(guardOf(use.body[0])).toBe("%g.%lazy.0 %lazy.0");
  // The initializer itself is unchanged, and the entry is not guarded: its
  // own statements do not name the table.
  expect(named(out, "%init.1")).toBe(named(mod, "%init.1"));
  expect(named(out, "%init.0").body.some((s) => guardOf(s) !== null)).toBe(false);
  // The place notes that it was reached, and runs the module when the
  // group is already active; the run takes the members reached so far.
  const place = named(out, "%lazy.at.1");
  expect(place.body.map((s) => s.kind)).toEqual(["if", "assign", "if"]);
  expect(place.body[1]).toMatchObject({ localId: "%g.%lazy.0.reached", value: { value: 1 } });
  expect(place.body[2]).toMatchObject({
    cond: { kind: "varRef", localId: "%g.%lazy.0" },
    then: [{ expr: { callee: "%init.1" } }],
  });
  const group = named(out, "%lazy.0");
  expect(group.body.map((s) => s.kind)).toEqual(["if", "assign", "if"]);
  expect(group.body[2]).toMatchObject({
    cond: { kind: "bin", op: ">", left: { localId: "%g.%lazy.0.reached" }, right: { value: 0 } },
    then: [{ expr: { callee: "%init.1" } }],
  });
  expect(out.globals!.map((g) => g.id)).toEqual(
    expect.arrayContaining(["%g.%lazy.0", "%g.%lazy.0.reached"]),
  );
});

test("what a module does while it loads keeps it where it is", () => {
  const cases: [string, IrStmt[], RegExp][] = [
    [
      "output",
      [
        {
          kind: "exprStmt",
          expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
          loc,
        },
      ],
      /'intrinsic' expression/,
    ],
    [
      "the clock",
      [assign("%g.m1.table", { kind: "libCall", fn: "date.now", args: [], type: F64, loc })],
      /date\.now/,
    ],
    ["an error", [{ kind: "throw", value: num(1), loc } as IrStmt], /'throw' statement/],
    [
      "an untyped call",
      [
        {
          kind: "exprStmt",
          expr: {
            kind: "dynCall",
            callee: ref("x", { kind: "dyn" }),
            args: [],
            type: { kind: "dyn" },
            loc,
          },
          loc,
        } as unknown as IrStmt,
      ],
      /'dynCall' expression/,
    ],
  ];
  for (const [what, body, reason] of cases) {
    const mod = program(
      [
        seven,
        init(1, [], [assign("%g.m1.table", call("seven", [], F64)), ...body]),
        fn("use", [{ kind: "return", value: ref("%g.m1.table"), loc }], F64),
        entry([1], []),
      ],
      [global("%g.m1.table")],
    );
    const { out, verdicts } = defer(mod);
    expect(out, what).toBe(mod);
    expect(verdicts.get("%init.1")?.reason, what).toMatch(reason);
  }
});

test("an effect in a function the initializer calls counts, also through a closure", () => {
  const prints = fn("prints", [
    {
      kind: "exprStmt",
      expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
      loc,
    },
  ]);
  const direct = program(
    [prints, init(1, [], [run("prints"), assign("%g.m1.table", num(1))]), entry([1], [])],
    [global("%g.m1.table")],
  );
  expect(defer(direct).verdicts.get("%init.1")?.reason).toMatch(/prints holds a 'intrinsic'/);
  const closed: IrExpr = {
    kind: "closure",
    fnName: "prints",
    captures: [],
    type: { kind: "func", params: [], ret: VOID },
    loc,
  };
  const through = program(
    [
      prints,
      seven,
      init(
        1,
        [],
        [assign("%g.m1.callback", closed), assign("%g.m1.table", call("seven", [], F64))],
      ),
      entry([1], []),
    ],
    [global("%g.m1.table"), global("%g.m1.callback", { kind: "func", params: [], ret: VOID })],
  );
  expect(defer(through).verdicts.get("%init.1")?.reason).toMatch(/prints holds a 'intrinsic'/);
});

test("a throw anywhere the initializer can reach keeps it, a throw elsewhere does not", () => {
  const thrower = fn("thrower", [{ kind: "throw", value: num(1), loc } as IrStmt]);
  const mod = program(
    [
      seven,
      thrower,
      init(1, [], [assign("%g.m1.table", call("seven", [], F64))]),
      fn("use", [run("thrower"), { kind: "return", value: ref("%g.m1.table"), loc }], F64),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  expect(defer(mod).verdicts.get("%init.1")?.group).toBe("%lazy.0");
});

test("modules that share a binding form one group and keep their order", () => {
  // m1 owns a counter; m2 and m4 draw from it while they load; m3, between
  // them, prints. The entry imports 2, 3, 4.
  const draw = fn(
    "draw",
    [
      assign("%g.m1.next", add(ref("%g.m1.next"), num(1))),
      { kind: "return", value: ref("%g.m1.next"), loc },
    ],
    F64,
  );
  const mod = program(
    [
      draw,
      init(1, [], [assign("%g.m1.next", num(0))]),
      init(2, [1], [assign("%g.m2.a", call("draw", [], F64))]),
      init(
        3,
        [1],
        [
          {
            kind: "exprStmt",
            expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
            loc,
          },
        ],
      ),
      init(4, [1, 2], [assign("%g.m4.b", call("draw", [], F64))]),
      fn("use", [{ kind: "return", value: add(ref("%g.m2.a"), ref("%g.m4.b")), loc }], F64),
      entry([2, 3, 4], [when(unknown, [{ kind: "exprStmt", expr: call("use", [], F64), loc }])]),
    ],
    [global("%g.m1.next", F64, true), global("%g.m2.a"), global("%g.m4.b")],
  );
  const { out, verdicts } = defer(mod);
  expect([1, 2, 4].map((n) => verdicts.get(`%init.${n}`)?.group)).toEqual([
    "%lazy.0",
    "%lazy.0",
    "%lazy.0",
  ]);
  expect(verdicts.get("%init.3")?.group).toBeNull();
  // The entry visits the places of 2 and 4 and still runs 3 between them;
  // 3 visits the place of 1.
  expect(callees(named(out, "%init.0"))).toEqual(["%lazy.at.2", "%init.3", "%lazy.at.4"]);
  expect(callees(named(out, "%init.3")).slice(0, 1)).toEqual(["%lazy.at.1"]);
  // A member keeps the loads of its own group.
  expect(callees(named(out, "%init.4"))).toEqual(["%init.1", "%init.2"]);
  // A member's place visits its imports' places first.
  expect(callees(named(out, "%lazy.at.4"))).toEqual(["%lazy.at.1", "%lazy.at.2"]);
  // The run takes the members in the order their modules ran: 1, 2, 4.
  const group = named(out, "%lazy.0");
  expect(
    group.body
      .slice(2)
      .map((s) =>
        s.kind === "if" ? (s.then[0] as { expr: { callee: string } }).expr.callee : null,
      ),
  ).toEqual(["%init.1", "%init.2", "%init.4"]);
  // The counter's function is guarded: whoever draws runs the group first.
  expect(guardOf(named(out, "draw").body[0])).toBe("%g.%lazy.0 %lazy.0");
});

test("guards stand before the statement, outside loops, and inside the branch that reads", () => {
  const read: IrStmt = { kind: "exprStmt", expr: ref("%g.m1.table"), loc };
  const loop: IrStmt = { kind: "while", cond: unknown, body: [read], loc };
  const mod = program(
    [
      seven,
      init(1, [], [assign("%g.m1.table", call("seven", [], F64))]),
      fn("loops", [{ kind: "exprStmt", expr: num(0), loc }, loop, read]),
      fn("branches", [
        when(unknown, [read, read], [{ kind: "exprStmt", expr: num(0), loc }]),
        read,
      ]),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  const { out } = defer(mod);
  // One guard, before the loop; the read after the loop needs none.
  const loops = named(out, "loops");
  expect(loops.body.map((s) => s.kind)).toEqual(["exprStmt", "if", "while", "exprStmt"]);
  expect(guardOf(loops.body[1])).toBe("%g.%lazy.0 %lazy.0");
  expect(loops.body[2]).toBe(loop);
  // The branch that reads is guarded once; the other is not, so the read
  // after the `if` is guarded again.
  const branches = named(out, "branches");
  expect(branches.body.map((s) => s.kind)).toEqual(["if", "if", "exprStmt"]);
  const first = branches.body[0] as IrStmt & { kind: "if" };
  expect(first.then.map((s) => s.kind)).toEqual(["if", "exprStmt", "exprStmt"]);
  expect(first.else_!.map((s) => s.kind)).toEqual(["exprStmt"]);
  expect(guardOf(branches.body[1])).toBe("%g.%lazy.0 %lazy.0");
});

test("a constant of a module that stays is read freely; another value of it is not", () => {
  const prints: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
    loc,
  };
  const build = (type: IrType): IrModule =>
    program(
      [
        seven,
        init(
          1,
          [],
          [
            prints,
            assign(
              "%g.m1.base",
              type === F64 ? num(3) : ({ kind: "arrayLit", elems: [], type, loc } as IrExpr),
            ),
          ],
        ),
        init(
          2,
          [1],
          [
            assign("%g.m2.table", call("seven", [], F64)),
            { kind: "exprStmt", expr: ref("%g.m1.base", type), loc },
          ],
        ),
        fn("use", [{ kind: "return", value: ref("%g.m2.table"), loc }], F64),
        entry([2], []),
      ],
      [global("%g.m1.base", type), global("%g.m2.table")],
    );
  const constant = defer(build(F64));
  expect(constant.verdicts.get("%init.2")?.group).toBe("%lazy.0");
  // The staying module runs where it did; its constant gets no guard.
  expect(callees(named(constant.out, "%lazy.at.2"))).toEqual(["%init.1"]);
  expect(named(constant.out, "%init.1").body.some((s) => guardOf(s) !== null)).toBe(false);
  const array = defer(build({ kind: "array", elem: F64 }));
  expect(array.verdicts.get("%init.2")?.reason).toMatch(/'base' is made by a module that stays/);
});

test("modules the static import tree does not place stay", () => {
  const body = [assign("%g.m1.table", call("seven", [], F64))];
  const reader = fn("use", [{ kind: "return", value: ref("%g.m1.table"), loc }], F64);
  // Loaded by a function: a dynamic import.
  const dynamic = program(
    [seven, init(1, [], body), reader, fn("load", [run("%init.1")]), entry([], [])],
    [global("%g.m1.table")],
  );
  expect(defer(dynamic).out).toBe(dynamic);
  // Imported by a module that is loaded dynamically.
  const below = program(
    [
      seven,
      init(1, [], body),
      init(2, [1], []),
      reader,
      fn("load", [run("%init.2")]),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  expect(defer(below).verdicts.get("%init.1")?.reason).toMatch(/loaded dynamically/);
  // Two modules that import each other.
  const cycle = program(
    [seven, init(1, [2], body), init(2, [1], []), reader, entry([1], [])],
    [global("%g.m1.table")],
  );
  expect(defer(cycle).verdicts.get("%init.1")?.reason).toMatch(/import cycle/);
  // A load after the module's own first statement.
  const late = program(
    [
      seven,
      init(1, [], body),
      fn("%init.2", [
        ...init(2, [], [assign("%g.m2.x", call("seven", [], F64))]).body,
        run("%init.1"),
      ]),
      reader,
      entry([2], []),
    ],
    [global("%g.m1.table"), global("%g.m2.x")],
  );
  expect(defer(late).verdicts.get("%init.2")?.reason).toMatch(/after its own first statement/);
});

test("a group the start-up code uses for certain, or too small to matter, stays", () => {
  const body = [assign("%g.m1.table", call("seven", [], F64))];
  const reader = fn("use", [{ kind: "return", value: ref("%g.m1.table"), loc }], F64);
  // The entry reads the table as a top-level statement.
  const direct = program(
    [
      seven,
      init(1, [], body),
      reader,
      entry([1], [{ kind: "exprStmt", expr: ref("%g.m1.table"), loc }]),
    ],
    [global("%g.m1.table")],
  );
  expect(defer(direct).out).toBe(direct);
  expect(defer(direct).verdicts.get("%init.1")?.reason).toMatch(/start-up code uses it/);
  // The entry calls a function that reads it.
  const called = program(
    [
      seven,
      init(1, [], body),
      reader,
      entry([1], [{ kind: "exprStmt", expr: call("use", [], F64), loc }]),
    ],
    [global("%g.m1.table")],
  );
  expect(defer(called).out).toBe(called);
  // A literal and nothing else.
  const small = program(
    [init(1, [], [assign("%g.m1.table", add(num(1), num(2)))]), reader, entry([1], [])],
    [global("%g.m1.table")],
  );
  expect(defer(small).out).toBe(small);
  expect(defer(small).verdicts.get("%init.1")?.reason).toMatch(/too small/);
});

test("bindings a guard cannot stand in front of keep their module", () => {
  const body = [assign("%g.m1.table", call("seven", [], F64))];
  const reader = fn("use", [{ kind: "return", value: ref("%g.m1.table"), loc }], F64);
  // A temporal dead zone: the read's own check already has a meaning.
  const tdz = program(
    [seven, init(1, [], body), reader, entry([1], [])],
    [{ ...global("%g.m1.table"), tdz: true }],
  );
  expect(defer(tdz).verdicts.get("%init.1")?.reason).toMatch(/before its declaration/);
  // Captured by a closure.
  const capturing: IrExpr = {
    kind: "closure",
    fnName: "seven",
    captures: ["%g.m1.table"],
    type: { kind: "func", params: [], ret: F64 },
    loc,
  };
  const captured = program(
    [
      seven,
      init(1, [], body),
      reader,
      fn("holds", [{ kind: "exprStmt", expr: capturing, loc }]),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  expect(defer(captured).verdicts.get("%init.1")?.reason).toMatch(
    /captured or named by class metadata/,
  );
  // Library builds and worker programs are left alone.
  const plain = program(
    [seven, init(1, [], body), reader, entry([1], [])],
    [global("%g.m1.table")],
  );
  expect(defer(plain).out).not.toBe(plain);
  expect(defer({ ...plain, workers: true }).out.functions).toBe(plain.functions);
});
