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
import {
  deferClosedInitializers,
  initializerTrace,
  type LazyInitializerVerdict,
} from "./lazy-initializers.js";

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
const CAUGHT: IrType = { kind: "caught" };
const failed = (n: number): string => `%g.m${n}.%loaded%failed`;
const error = (n: number): string => `%g.m${n}.%loaded%error`;
/** Module `n`'s initializer in the form of a module the program can load
 * again after it threw: the error is kept and thrown again. */
const recording = (n: number, imports: number[], body: IrStmt[]): IrFunction => ({
  ...fn(`%init.${n}`, [
    when(ref(loaded(n), BOOL), [
      when(ref(failed(n), BOOL), [{ kind: "rethrow", localId: error(n), loc }]),
      { kind: "return", value: null, loc },
    ]),
    assign(loaded(n), { kind: "boolLit", value: true, type: BOOL, loc }),
    {
      kind: "tryCatch",
      tryBody: [...imports.map((dep) => run(`%init.${dep}`)), ...body],
      catchBody: [
        assign(error(n), ref(`%moduleError.${n}`, CAUGHT)),
        assign(failed(n), { kind: "boolLit", value: true, type: BOOL, loc }),
        { kind: "rethrow", localId: `%moduleError.${n}`, loc },
      ],
      catchLocalId: `%moduleError.${n}`,
      finallyBody: null,
      loc,
    },
  ]),
  locals: [{ id: `%moduleError.${n}`, name: "%moduleError", type: CAUGHT, mutable: false }],
});
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
      ...modules.flatMap((n) => [
        global(loaded(n), BOOL, true),
        global(failed(n), BOOL, true),
        global(error(n), CAUGHT, true),
      ]),
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
/** `if (!%g.%lazy.N) { %lazy.N(); %g.%lazy.N = true; }` */
const guardOf = (stmt: IrStmt | undefined): string | null =>
  stmt?.kind === "if" &&
  stmt.cond.kind === "unary" &&
  stmt.cond.operand.kind === "varRef" &&
  stmt.then.length === 2 &&
  stmt.then[0]!.kind === "exprStmt" &&
  stmt.then[0]!.expr.kind === "call" &&
  stmt.then[1]!.kind === "assign" &&
  stmt.then[1]!.localId === stmt.cond.operand.localId &&
  stmt.then[1]!.value.kind === "boolLit" &&
  stmt.then[1]!.value.value
    ? `${stmt.cond.operand.localId} ${stmt.then[0]!.expr.callee}`
    : null;
/** The members a group's run can take: [number in the group, initializer]. */
const runOrder = (group: IrFunction): [number, string][] => {
  const loop = group.body[group.body.length - 1] as IrStmt & { kind: "while" };
  const select = loop.body[0] as IrStmt & { kind: "switch" };
  return select.cases.flatMap((c): [number, string][] =>
    c.test?.kind === "numLit"
      ? [[c.test.value, (c.body[1] as { expr: { callee: string } }).expr.callee]]
      : [],
  );
};
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
  // The initializer keeps its guard and its own statements, and the entry
  // is not guarded: its own statements do not name the table.
  expect(named(out, "%init.1").body).toEqual(named(mod, "%init.1").body);
  expect(named(out, "%init.0").body.some((s) => guardOf(s) !== null)).toBe(false);
  // The place notes that it was reached: in an idle group it puts the
  // module on the group's list, in an active one it runs it.
  const place = named(out, "%lazy.at.1");
  expect(place.body.map((s) => s.kind)).toEqual(["if", "assign", "if"]);
  expect(place.body[0]).toMatchObject({
    cond: { localId: "%g.%lazy.at.1" },
    then: [{ kind: "return" }],
  });
  expect(place.body[1]).toMatchObject({ localId: "%g.%lazy.at.1", value: { value: true } });
  expect(place.body[2]).toMatchObject({
    cond: { kind: "varRef", localId: "%g.%lazy.0" },
    then: [{ expr: { callee: "%init.1" } }],
    else_: [
      { localId: "%g.%lazy.link.1", value: { localId: "%g.%lazy.0.last" } },
      { localId: "%g.%lazy.0.last", value: { value: 1 } },
    ],
  });
  // The run turns the list around and takes its members in order.
  const group = named(out, "%lazy.0");
  expect(group.body.map((s) => s.kind)).toEqual([
    "if",
    "assign",
    "varDecl",
    "varDecl",
    "varDecl",
    "while",
    "assign",
    "while",
  ]);
  expect(runOrder(group)).toEqual([[1, "%init.1"]]);
  expect(out.globals!.map((g) => g.id)).toEqual(
    expect.arrayContaining(["%g.%lazy.0", "%g.%lazy.0.last", "%g.%lazy.at.1", "%g.%lazy.link.1"]),
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
  // A member keeps its own statements only: its place loaded its imports.
  expect(callees(named(out, "%init.4"))).toEqual([]);
  // A member's place visits its imports' places first.
  expect(callees(named(out, "%lazy.at.4"))).toEqual(["%lazy.at.1", "%lazy.at.2"]);
  // The run can take every member; which and in what order is the list's.
  expect(runOrder(named(out, "%lazy.0"))).toEqual([
    [1, "%init.1"],
    [2, "%init.2"],
    [3, "%init.4"],
  ]);
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

test("a module is placed wherever it is loaded from", () => {
  const body = [assign("%g.m1.table", call("seven", [], F64))];
  const reader = fn("use", [{ kind: "return", value: ref("%g.m1.table"), loc }], F64);
  // Loaded by a function: a dynamic import, a require().
  const dynamic = program(
    [seven, init(1, [], body), reader, fn("load", [run("%init.1")]), entry([], [])],
    [global("%g.m1.table")],
  );
  const loadedByFunction = defer(dynamic);
  expect(loadedByFunction.verdicts.get("%init.1")?.group).toBe("%lazy.0");
  expect(callees(named(loadedByFunction.out, "load"))).toEqual(["%lazy.at.1"]);
  // Imported by a module that is loaded dynamically, and by the entry.
  const below = program(
    [
      seven,
      init(1, [], body),
      init(2, [1], [{ kind: "exprStmt", expr: unknown, loc }]),
      reader,
      fn("load", [run("%init.2")]),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  const both = defer(below);
  expect(both.verdicts.get("%init.1")?.group).toBe("%lazy.0");
  expect(callees(named(both.out, "%init.0"))).toEqual(["%lazy.at.1"]);
  expect(callees(named(both.out, "%init.2"))).toEqual(["%lazy.at.1"]);
  expect(callees(named(both.out, "load"))).toEqual(["%init.2"]);
});

test("a module the program can load again keeps an error of its imports at its place", () => {
  const body = [assign("%g.m2.table", call("seven", [], F64))];
  const thrower: IrStmt = { kind: "throw", value: num(1), loc } as IrStmt;
  const mod = program(
    [
      seven,
      // m1 throws while it loads; m2 imports it and only computes; m3
      // imports m2 and prints.
      recording(1, [], [thrower]),
      recording(2, [1], body),
      recording(
        3,
        [2],
        [
          {
            kind: "exprStmt",
            expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
            loc,
          },
        ],
      ),
      fn("use", [{ kind: "return", value: ref("%g.m2.table"), loc }], F64),
      fn("load", [run("%init.2"), run("%init.3")]),
      entry([], []),
    ],
    [global("%g.m2.table")],
  );
  const { out, verdicts } = defer(mod);
  expect(verdicts.get("%init.1")?.reason).toMatch(/'throw' statement/);
  expect(verdicts.get("%init.2")?.group).toBe("%lazy.0");
  expect(verdicts.get("%init.3")?.group).toBeNull();
  // The place: visited again after a failed load it throws the kept error;
  // the first time it loads the imports inside the record.
  const place = named(out, "%lazy.at.2");
  expect(place.body.map((s) => s.kind)).toEqual(["if", "assign", "tryCatch", "if"]);
  expect(place.body[0]).toMatchObject({
    cond: { localId: "%g.%lazy.at.2" },
    then: [
      { kind: "if", cond: { localId: failed(2) }, then: [{ kind: "rethrow", localId: error(2) }] },
      { kind: "return" },
    ],
  });
  expect(place.body[2]).toMatchObject({
    tryBody: [{ expr: { callee: "%init.1" } }],
    catchBody: [
      { kind: "assign", localId: error(2) },
      { kind: "assign", localId: failed(2), value: { value: true } },
      { kind: "rethrow", localId: "%moduleError.2" },
    ],
    catchLocalId: "%moduleError.2",
  });
  expect(place.locals.map((l) => l.id)).toEqual(["%moduleError.2"]);
  // The member: its guard and its own statements, with nothing that throws.
  const member = named(out, "%init.2");
  expect(member.body.map((s) => s.kind)).toEqual(["if", "assign", "assign"]);
  expect(member.body[0]).toMatchObject({ then: [{ kind: "return" }] });
  expect(member.locals).toEqual([]);
  // The importer that stays calls the place from inside its own record,
  // and so does the function that loads both.
  const importer = named(out, "%init.3");
  expect((importer.body[2] as IrStmt & { kind: "tryCatch" }).tryBody[0]).toMatchObject({
    expr: { callee: "%lazy.at.2" },
  });
  expect(callees(named(out, "load"))).toEqual(["%lazy.at.2", "%init.3"]);
});

test("modules that cannot be placed stay", () => {
  const body = [assign("%g.m1.table", call("seven", [], F64))];
  const reader = fn("use", [{ kind: "return", value: ref("%g.m1.table"), loc }], F64);
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
  // An initializer that awaits.
  const awaits = program(
    [seven, { ...init(1, [], body), async: true }, reader, entry([], [])],
    [global("%g.m1.table")],
  );
  expect(defer(awaits).verdicts.get("%init.1")?.reason).toMatch(/awaits/);
  // An initializer held as a function value.
  const held: IrExpr = {
    kind: "closure",
    fnName: "%init.1",
    captures: [],
    type: { kind: "func", params: [], ret: VOID },
    loc,
  };
  const value = program(
    [
      seven,
      init(1, [], body),
      reader,
      fn("holds", [{ kind: "exprStmt", expr: held, loc }]),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  expect(defer(value).verdicts.get("%init.1")?.reason).toMatch(/function value/);
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

test("only what the roots load for certain counts as start-up code", () => {
  const body = [assign("%g.m1.table", call("seven", [], F64))];
  const reads: IrStmt = { kind: "exprStmt", expr: ref("%g.m1.table"), loc };
  const prints: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
    loc,
  };
  // m2 prints and reads the table at its top level, and only a function
  // loads m2.
  const mod = program(
    [
      seven,
      recording(1, [], body),
      recording(2, [1], [prints, reads]),
      fn("load", [run("%init.2")]),
      entry([1], []),
    ],
    [global("%g.m1.table")],
  );
  const { out, verdicts } = defer(mod);
  expect(verdicts.get("%init.1")?.group).toBe("%lazy.0");
  // The reader's guard stands inside its record, after its loads.
  const reader = named(out, "%init.2").body[2] as IrStmt & { kind: "tryCatch" };
  expect(reader.tryBody.map((s) => s.kind)).toEqual(["exprStmt", "exprStmt", "if", "exprStmt"]);
  expect(reader.tryBody[0]).toMatchObject({ expr: { callee: "%lazy.at.1" } });
  expect(guardOf(reader.tryBody[2])).toBe("%g.%lazy.0 %lazy.0");
  // The same module imported by the entry is start-up code.
  const atStart = program(
    [seven, recording(1, [], body), recording(2, [1], [prints, reads]), entry([2], [])],
    [global("%g.m1.table")],
  );
  expect(defer(atStart).verdicts.get("%init.1")?.reason).toMatch(/start-up code uses it/);
});

test("the trace names each module with its verdict, and only when asked", () => {
  const prints: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: VOID, loc },
    loc,
  };
  const at = (file: string, f: IrFunction): IrFunction => ({ ...f, loc: { ...loc, file } });
  const mod = program(
    [
      seven,
      at("table.ts", init(1, [], [assign("%g.m1.table", call("seven", [], F64))])),
      at("loud.ts", init(2, [], [prints])),
      entry([1, 2], []),
    ],
    [global("%g.m1.table")],
  );
  expect(initializerTrace(mod, {})).toBeUndefined();
  expect(initializerTrace(mod, { SCRIPTC_INITIALIZERS_TRACE: "boot" })).toBeUndefined();
  const lines: string[] = [];
  const trace = initializerTrace(mod, { SCRIPTC_INITIALIZERS_TRACE: "defer" }, (line) =>
    lines.push(line),
  );
  // The trace changes nothing about what the pass builds.
  expect(deferClosedInitializers(mod, undefined, trace)).toEqual(deferClosedInitializers(mod));
  expect(lines).toEqual([
    "[initializers] defer table.ts: runs at the first use of what it makes (%lazy.0)\n",
    "[initializers] eager loud.ts: a 'intrinsic' expression (offset 0 of program.ts)\n",
    "[initializers] eager program.ts: the entry module\n",
  ]);
});
