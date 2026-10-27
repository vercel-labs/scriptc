import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
} from "../ir/ir.js";
import { completesNormally, computeMayThrow } from "./may-throw.js";

const loc = { file: "tdz.ts", start: 0, end: 1 };
const value: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
const local: IrLocal = {
  id: "value",
  name: "value",
  type: F64,
  mutable: true,
  boxed: true,
  tdz: true,
};
function fn(name: string, body: IrStmt[], locals: IrLocal[] = [local]): IrFunction {
  return { name, body, locals, params: [], returnType: VOID, loc };
}
function moduleWith(...functions: IrFunction[]): IrModule {
  return { irVersion: 17, sourceFile: loc.file, entry: "caller", functions };
}
const assignment: IrStmt = { kind: "assign", localId: local.id, value, loc };
const expression: IrExpr = { kind: "assignExpr", localId: local.id, value, type: F64, loc };
const increment: IrExpr = {
  kind: "incDec",
  localId: local.id,
  op: "+",
  prefix: false,
  type: F64,
  loc,
};
const read: IrExpr = { kind: "varRef", localId: local.id, type: F64, loc };
const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });

test.each([
  ["store", assignment],
  ["assignment expression", exprStmt(expression)],
  ["increment", exprStmt(increment)],
  ["read", exprStmt(read)],
] as const)("TDZ %s propagates through the direct call graph", (_name, operation) => {
  const target = fn("target", [operation]);
  const middle = fn(
    "middle",
    [exprStmt({ kind: "call", callee: "target", args: [], type: VOID, loc })],
    [],
  );
  const caller = fn(
    "caller",
    [exprStmt({ kind: "call", callee: "middle", args: [], type: VOID, loc })],
    [],
  );
  const answer = computeMayThrow(moduleWith(caller, middle, target));
  expect([...answer.fns].sort()).toEqual(["caller", "middle", "target"]);
  expect(answer.indirect).toBe(false);
});

test("TDZ stores seed indirect-call propagation", () => {
  const closure: IrExpr = {
    kind: "closure",
    fnName: "target",
    captures: [],
    type: funcOf([], VOID),
    loc,
  };
  const caller = fn(
    "caller",
    [exprStmt({ kind: "callValue", callee: closure, args: [], type: VOID, loc })],
    [],
  );
  const answer = computeMayThrow(moduleWith(caller, fn("target", [assignment])));
  expect(answer.indirect).toBe(true);
  expect([...answer.fns].sort()).toEqual(["caller", "target"]);
});

test.each([true, false])(
  "declaration stores do not throw solely for TDZ (mutable=%s)",
  (mutable) => {
    const initialize: IrStmt = { ...assignment, initializes: true };
    expect(
      computeMayThrow(moduleWith(fn("caller", [initialize], [{ ...local, mutable }]))).fns.size,
    ).toBe(0);
  },
);

test("legacy const TDZ stores remain initialization", () => {
  const immutable = { ...local, mutable: false };
  expect(computeMayThrow(moduleWith(fn("caller", [assignment], [immutable]))).fns.size).toBe(0);
});

test("ordinary boxed stores do not gain an exception edge", () => {
  const ordinary: IrLocal = {
    id: local.id,
    name: local.name,
    type: F64,
    mutable: true,
    boxed: true,
  };
  expect(
    computeMayThrow(
      moduleWith(fn("caller", [assignment, exprStmt(expression), exprStmt(increment)], [ordinary])),
    ).fns.size,
  ).toBe(0);
});

test("initializers still propagate exceptions from their right-hand side", () => {
  const initialize: IrStmt = {
    ...assignment,
    initializes: true,
    value: { kind: "call", callee: "failure", args: [], type: F64, loc },
  };
  const failure = fn("failure", [{ kind: "throw", value, loc }], []);
  expect([...computeMayThrow(moduleWith(fn("caller", [initialize]), failure)).fns].sort()).toEqual([
    "caller",
    "failure",
  ]);
});

const call = (callee: string): IrStmt =>
  exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
const closureOf = (fnName: string): IrExpr => ({
  kind: "closure",
  fnName,
  captures: [],
  type: funcOf([], VOID),
  loc,
});
const callClosure = (fnName: string): IrStmt =>
  exprStmt({ kind: "callValue", callee: closureOf(fnName), args: [], type: VOID, loc });
const failure: IrStmt = { kind: "throw", value, loc };

test("propagates through a long caller-first chain without recursive graph traversal", () => {
  const size = 6000;
  const functions = Array.from({ length: size }, (_, i) =>
    fn(`fn${i}`, [i === size - 1 ? failure : call(`fn${i + 1}`)], []),
  );
  for (const order of [functions, [...functions].reverse()]) {
    const answer = computeMayThrow(moduleWith(...order));
    expect(answer.indirect).toBe(false);
    expect(answer.fns).toEqual(new Set(functions.map((f) => f.name)));
  }
});

test("recursive components only throw when they reach a throwing seed", () => {
  const mod = moduleWith(
    fn("caller", [call("left"), call("left")], []),
    fn("left", [call("right")], []),
    fn("right", [call("left")], []),
    fn("pure", [call("pure")], []),
  );
  expect(computeMayThrow(mod).fns.size).toBe(0);
  mod.functions[2]!.body.push(failure);
  expect(computeMayThrow(mod).fns).toEqual(new Set(["caller", "left", "right"]));
});

test("a transitively throwing closure activates indirect callers and their callers", () => {
  const mod = moduleWith(
    fn("outer", [call("indirect")], []),
    fn("indirect", [callClosure("wrapper")], []),
    fn("wrapper", [call("target")], []),
    fn("target", [failure], []),
    fn("otherIndirect", [callClosure("pure")], []),
    fn("pure", [], []),
  );
  const before = structuredClone(mod);
  const answer = computeMayThrow(mod);
  expect(answer.indirect).toBe(true);
  expect(answer.fns).toEqual(new Set(["outer", "indirect", "wrapper", "target", "otherIndirect"]));
  expect(mod).toEqual(before);
  mod.functions[3]!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
  expect(answer.fns.size).toBe(5);
});

test.each(["async", "generator", "async generator"])(
  "a throwing %s body does not unwind direct or indirect callers",
  (kind) => {
    const target = fn("target", [failure], []);
    if (kind.includes("async")) target.async = true;
    if (kind.includes("generator"))
      target.generator = {
        yieldT: F64,
        nextT: VOID,
        resultType: { kind: "record", shapeId: "result" },
      };
    const mod = moduleWith(fn("caller", [call("target"), callClosure("target")], []), target);
    expect(computeMayThrow(mod)).toEqual({ fns: new Set(["target"]), indirect: false });
  },
);

test("dynamic function adapters activate indirect calls without an IR closure target", () => {
  const adapter: IrExpr = {
    kind: "dynCheck",
    value: { kind: "varRef", localId: "unknown", type: DYN, loc },
    type: funcOf([], VOID),
    loc,
  };
  const callee: IrExpr = { kind: "varRef", localId: "callback", type: funcOf([], VOID), loc };
  const mod = moduleWith(
    fn("caller", [call("indirect")], []),
    fn("indirect", [exprStmt({ kind: "callValue", callee, args: [], type: VOID, loc })], []),
    fn("adapter", [exprStmt(adapter)], []),
  );
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(["caller", "indirect", "adapter"]),
    indirect: true,
  });
});

const construct = (className: string, direct = false): IrStmt =>
  exprStmt(
    direct
      ? { kind: "new", className, args: [], type: { kind: "object", className }, loc }
      : {
          kind: "newValue",
          callee: { kind: "classRef", className, type: { kind: "classval", className }, loc },
          args: [],
          type: { kind: "object", className },
          loc,
        },
  );

test("class-value construction includes descendants without making direct or sibling construction throw", () => {
  const mod = moduleWith(
    fn("caller", [call("rootValue")], []),
    ...["Root", "Middle", "Leaf", "Sibling", "Other"].flatMap((name) => [
      fn(`${name.toLowerCase()}Value`, [construct(name), construct(name)], []),
      fn(`${name.toLowerCase()}Direct`, [construct(name, true)], []),
      fn(`%${name}.constructor`, name === "Leaf" || name === "Other" ? [call("failure")] : [], []),
    ]),
    fn("failure", [failure], []),
  );
  mod.classes = [
    { name: "Leaf", base: "Middle", fields: [], loc },
    { name: "Sibling", base: "Root", fields: [], loc },
    { name: "Middle", base: "Root", fields: [], loc },
    { name: "Other", fields: [], loc },
    { name: "Root", fields: [], loc },
  ];
  const before = structuredClone(mod);
  const expected = new Set([
    "failure",
    "%Leaf.constructor",
    "%Other.constructor",
    "caller",
    "rootValue",
    "middleValue",
    "leafValue",
    "leafDirect",
    "otherValue",
    "otherDirect",
  ]);
  expect(computeMayThrow(mod)).toEqual({ fns: expected, indirect: false });
  expect(mod).toEqual(before);
  mod.classes.reverse();
  mod.functions.reverse();
  expect(computeMayThrow(mod)).toEqual({ fns: expected, indirect: false });
  mod.functions.find((f) => f.name === "%Leaf.constructor")!.body = [];
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(["failure", "%Other.constructor", "otherValue", "otherDirect"]),
    indirect: false,
  });
});

test("class-value dependencies participate in the call graph fixpoint", () => {
  const mod = moduleWith(
    fn("caller", [construct("Root")], []),
    fn("direct", [construct("Root", true)], []),
    fn("%Root.constructor", [], []),
    fn("%Child.constructor", [construct("Other")], []),
    fn("%Other.constructor", [construct("Root")], []),
    fn("%OtherChild.constructor", [call("failure")], []),
    fn("failure", [failure], []),
  );
  mod.classes = [
    { name: "Root", fields: [], loc },
    { name: "Child", base: "Root", fields: [], loc },
    { name: "Other", fields: [], loc },
    { name: "OtherChild", base: "Other", fields: [], loc },
  ];
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set([
      "failure",
      "%OtherChild.constructor",
      "%Child.constructor",
      "%Other.constructor",
      "caller",
    ]),
    indirect: false,
  });
  mod.functions.find((f) => f.name === "failure")!.body = [];
  expect(computeMayThrow(mod)).toEqual({ fns: new Set(), indirect: false });
});

test("propagates construction through a deep hierarchy without descendant expansion or recursive traversal", () => {
  const size = 6000;
  const mod = moduleWith(
    ...Array.from({ length: size }, (_, i) => fn(`factory${i}`, [construct(`C${i}`)], [])),
    fn(`%C${size - 1}.constructor`, [failure], []),
  );
  mod.classes = Array.from({ length: size }, (_, i) => ({
    name: `C${i}`,
    ...(i > 0 ? { base: `C${i - 1}` } : {}),
    fields: [],
    loc,
  })).reverse();
  expect(computeMayThrow(mod)).toEqual({
    fns: new Set(mod.functions.map((f) => f.name)),
    indirect: false,
  });
});

test("generic collection mutation propagates checked storage failures to callers", () => {
  const mapType = { kind: "map" as const, key: DYN, value: DYN };
  const setType = { kind: "set" as const, elem: DYN };
  const map: IrExpr = { kind: "varRef", localId: "map", type: mapType, loc };
  const set: IrExpr = { kind: "varRef", localId: "set", type: setType, loc };
  const input: IrExpr = { kind: "varRef", localId: "input", type: DYN, loc };
  const write: IrExpr = {
    kind: "mapIntrinsic",
    method: "set",
    receiver: map,
    args: [input, input],
    type: VOID,
    loc,
  };
  const add: IrExpr = {
    kind: "setIntrinsic",
    method: "add",
    receiver: set,
    args: [input],
    type: VOID,
    loc,
  };
  const caller = fn(
    "caller",
    [exprStmt({ kind: "call", callee: "write", args: [], type: VOID, loc })],
    [],
  );
  expect(
    computeMayThrow(
      moduleWith(caller, fn("write", [exprStmt(write)], []), fn("add", [exprStmt(add)], [])),
    ).fns,
  ).toEqual(new Set(["caller", "write", "add"]));
});

test("worker programs poll for termination only where execution can be unbounded", () => {
  const call = (callee: string): IrStmt =>
    exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
  const plain = (name: string, body: IrStmt[]): IrFunction => fn(name, body, []);
  const loop: IrStmt = {
    kind: "while",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    body: [],
    loc,
  };
  const mod: IrModule = {
    ...moduleWith(
      plain("caller", [call("leaf"), call("looping"), call("left"), call("indirect")]),
      plain("leaf", [exprStmt(value)]),
      plain("leafCaller", [call("leaf")]),
      plain("looping", [loop]),
      plain("left", [call("right")]),
      plain("right", [call("left")]),
      plain("self", [call("self")]),
      plain("indirect", [
        exprStmt({
          kind: "callValue",
          callee: { kind: "closure", fnName: "leaf", captures: [], type: funcOf([], VOID), loc },
          args: [],
          type: VOID,
          loc,
        }),
      ]),
    ),
    workers: true,
  };
  const answer = computeMayThrow(mod);
  // The entry, call cycles and unbounded operations poll on entry; a loop
  // polls itself; bounded leaves poll nowhere and unwind nothing.
  expect([...answer.workerEntryPolls!].sort()).toEqual([
    "caller",
    "indirect",
    "left",
    "right",
    "self",
  ]);
  expect([...answer.fns].sort()).toEqual([
    "caller",
    "indirect",
    "left",
    "looping",
    "right",
    "self",
  ]);
  expect(computeMayThrow({ ...mod, workers: false }).workerEntryPolls).toBeUndefined();
});

test("stack checks cover every recursive cycle, including recursion through reentrant operations", () => {
  const mod = moduleWith(
    fn("caller", [call("self"), call("left"), call("leaf"), call("walker")], []),
    fn("self", [call("self"), call("leaf")], []),
    fn("left", [call("right")], []),
    fn("right", [call("left")], []),
    fn("leaf", [exprStmt(value)], []),
    // walker reaches itself only through a closure it calls indirectly.
    fn("walker", [callClosure("step")], []),
    fn("step", [call("walker")], []),
    // A reentrant leaf whose closure targets never come back stays unchecked.
    fn("visitor", [callClosure("leaf")], []),
  );
  const answer = computeMayThrow(mod, { stackChecks: true });
  // One check per cycle: self, one of left and right, and one of walker and
  // step (the earlier function on ties).
  expect([...answer.stackChecks!].sort()).toEqual(["left", "self", "walker"]);
  expect(
    [...computeMayThrow(mod, { stackChecks: "everyCycleMember" }).stackChecks!].sort(),
  ).toEqual(["left", "right", "self", "step", "walker"]);
  // Checked functions throw the overflow RangeError, so their callers poll;
  // a throwing closure target makes every indirect call poll as well.
  expect(answer.indirect).toBe(true);
  expect([...answer.fns].sort()).toEqual([
    "caller",
    "left",
    "right",
    "self",
    "step",
    "visitor",
    "walker",
  ]);
  expect(computeMayThrow(mod).stackChecks).toBeUndefined();
  expect(computeMayThrow(mod).fns.size).toBe(0);
});

test("synchronous functions on a checked cycle skip the worker entry poll", () => {
  const asyncSelf: IrFunction = { ...fn("asyncSelf", [call("asyncSelf")], []), async: true };
  const mod: IrModule = {
    ...moduleWith(
      fn("caller", [call("caller"), call("self"), call("left"), call("walker")], []),
      fn("self", [call("self")], []),
      fn("left", [call("right")], []),
      fn("right", [call("left")], []),
      fn("walker", [callClosure("leaf")], []),
      fn("leaf", [exprStmt(value)], []),
      asyncSelf,
    ),
    workers: true,
  };
  const answer = computeMayThrow(mod, { stackChecks: true });
  expect([...answer.stackChecks!].sort()).toEqual(["asyncSelf", "caller", "left", "self"]);
  // Callers test after every call of a function on a checked cycle (it may
  // throw), and an overflow unwinds through those tests, so only the module
  // entry, async bodies and unbounded functions off any cycle poll on entry;
  // right needs no poll although left holds the cycle's check.
  expect([...answer.workerEntryPolls!].sort()).toEqual(["asyncSelf", "caller", "walker"]);
  expect(answer.fns.has("self") && answer.fns.has("left") && answer.fns.has("right")).toBe(true);
  // Without stack checks (WASI, Windows, libraries) every cycle keeps its poll.
  expect([...computeMayThrow(mod).workerEntryPolls!].sort()).toEqual([
    "asyncSelf",
    "caller",
    "left",
    "right",
    "self",
    "walker",
  ]);
});

test("stack checks meet every cycle once and bound the runs between checks", () => {
  // A ring of 80 functions, with a chord from fn10 back to fn0, and a
  // separate ring of three whose functions also call each other backwards.
  const ring = Array.from({ length: 80 }, (_, i) =>
    fn(`fn${i}`, i === 10 ? [call("fn11"), call("fn0")] : [call(`fn${(i + 1) % 80}`)], []),
  );
  const mod = moduleWith(
    ...ring,
    fn("a", [call("b"), call("c")], []),
    fn("b", [call("c"), call("a")], []),
    fn("c", [call("a"), call("b")], []),
  );
  const checks = computeMayThrow(mod, { stackChecks: true }).stackChecks!;
  // Removing the checked functions leaves no cycle, and no run of more than
  // 32 unchecked calls.
  const callees = new Map(
    mod.functions.map((f) => [
      f.name,
      f.body.flatMap((s) =>
        s.kind === "exprStmt" && s.expr.kind === "call" ? [s.expr.callee] : [],
      ),
    ]),
  );
  const longest = new Map<string, number>();
  const visiting = new Set<string>();
  const run = (name: string): number => {
    if (checks.has(name)) return 0;
    expect(visiting.has(name)).toBe(false);
    const known = longest.get(name);
    if (known !== undefined) return known;
    visiting.add(name);
    const depth = 1 + Math.max(0, ...callees.get(name)!.map(run));
    visiting.delete(name);
    longest.set(name, depth);
    return depth;
  };
  for (const f of mod.functions) expect(run(f.name)).toBeLessThanOrEqual(32);
  // fn0 breaks both ring cycles, fn33 and fn66 bound the run along the
  // ring, and two of a, b and c break their four cycles.
  expect([...checks].sort()).toEqual(["a", "b", "fn0", "fn33", "fn66"]);
});

test("class members are reachable from reentrant operations", () => {
  const mod: IrModule = {
    ...moduleWith(
      fn("%Shape.describe", [exprStmt({ kind: "dynFrom", value, type: DYN, loc })], []),
      fn("%Shape.area", [exprStmt(value)], []),
      fn("%main", [exprStmt({ kind: "dynFrom", value, type: DYN, loc })], []),
    ),
    classes: [{ name: "Shape", fields: [], methods: ["describe", "area"], loc }],
  };
  const answer = computeMayThrow(mod, { stackChecks: true });
  // describe stays bounded too: dynFrom is a plain conversion.
  expect([...answer.stackChecks!]).toEqual([]);
  mod.functions[0]!.body = [
    exprStmt({
      kind: "dynInvoke",
      recv: { kind: "dynFrom", value, type: DYN, loc },
      method: "describe",
      calleeName: "describe",
      args: [],
      type: DYN,
      loc,
    }),
  ];
  mod.functions[2]!.body = mod.functions[0]!.body;
  expect([...computeMayThrow(mod, { stackChecks: true }).stackChecks!]).toEqual([
    "%Shape.describe",
  ]);
});

test("throw-only, storage and primitive library operations stay bounded in workers", () => {
  const text: IrExpr = { kind: "strLit", value: "a", type: STRING, loc };
  const nodeThrow: IrExpr = {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [value, text, text],
    type: VOID,
    loc,
  };
  const stringCall = (arg: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "string.lastIndexOf",
    args: [text, arg],
    type: F64,
    loc,
  });
  const dynArg: IrExpr = { kind: "dynFrom", value: { ...value }, type: DYN, loc };
  const mod: IrModule = {
    ...moduleWith(
      fn("thrower", [exprStmt(nodeThrow)], []),
      fn("primitive", [exprStmt(stringCall(text))], []),
      fn("dynamic", [exprStmt(stringCall(dynArg))], []),
    ),
    workers: true,
  };
  // Only a library call that can reach a dynamic value's conversion polls.
  expect([...computeMayThrow(mod).workerEntryPolls!].sort()).toEqual(["dynamic"]);
});

test("explain names the first throwing operation and each call edge", () => {
  const message: IrExpr = {
    kind: "strLit",
    value: "Cannot read properties of undefined (reading 'length')",
    type: STRING,
    loc,
  };
  const code: IrExpr = { kind: "strLit", value: "", type: STRING, loc };
  const typeError: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  const nodeThrow: IrExpr = {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [typeError, code, message],
    type: VOID,
    loc,
  };
  const callLoc = { file: "tdz.ts", start: 5, end: 9 };
  const mod = moduleWith(
    fn("thrower", [exprStmt(nodeThrow)], []),
    fn(
      "caller",
      [exprStmt({ kind: "call", callee: "thrower", args: [], type: VOID, loc: callLoc })],
      [],
    ),
    fn("quiet", [exprStmt(value)], []),
  );
  const result = computeMayThrow(mod, { explain: true });
  expect([...result.fns].sort()).toEqual(["caller", "thrower"]);
  expect(result.why?.get("thrower")).toEqual({
    kind: "seed",
    what: "throws TypeError: Cannot read properties of undefined (reading 'length')",
    loc,
  });
  expect(result.why?.get("caller")).toEqual({ kind: "call", callee: "thrower", loc: callLoc });
  // Without the option the analysis records nothing extra.
  expect(computeMayThrow(mod).why).toBeUndefined();
});

test("handlers discharge the exceptions they take, and only those", () => {
  const call = (callee: string): IrStmt =>
    exprStmt({ kind: "call", callee, args: [], type: VOID, loc });
  const throwing: IrStmt = { kind: "throw", value, loc };
  const ret: IrStmt = { kind: "return", value: null, loc };
  const tryCatch = (
    tryBody: IrStmt[],
    catchBody: IrStmt[] | null,
    finallyBody: IrStmt[] | null = null,
  ): IrStmt => ({ kind: "tryCatch", tryBody, catchBody, catchLocalId: null, finallyBody, loc });
  const plain = (name: string, body: IrStmt[]): IrFunction => fn(name, body, []);
  const cond: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  const mod = moduleWith(
    plain("thrower", [throwing]),
    plain("caught", [tryCatch([call("thrower"), throwing], [])]),
    plain("callsCaught", [call("caught")]),
    plain("rethrows", [tryCatch([call("thrower")], [throwing])]),
    plain("finallyOnly", [tryCatch([call("thrower")], null, [exprStmt(value)])]),
    plain("finallyReturns", [tryCatch([call("thrower")], [throwing], [ret])]),
    plain("finallyMayComplete", [
      tryCatch([call("thrower")], null, [{ kind: "if", cond, then: [ret], else_: null, loc }]),
    ]),
    plain("finallyThrows", [tryCatch([], [], [call("thrower")])]),
    plain("nested", [tryCatch([tryCatch([call("thrower")], [throwing])], [])]),
    plain("indirectCaught", [
      tryCatch(
        [
          exprStmt({
            kind: "callValue",
            callee: {
              kind: "closure",
              fnName: "thrower",
              captures: [],
              type: funcOf([], VOID),
              loc,
            },
            args: [],
            type: VOID,
            loc,
          }),
        ],
        [],
      ),
    ]),
    plain("caller", []),
  );
  const answer = computeMayThrow(mod);
  expect([...answer.fns].sort()).toEqual([
    "finallyMayComplete",
    "finallyOnly",
    "finallyThrows",
    "rethrows",
    "thrower",
  ]);
  // The function value can still throw at other call sites.
  expect(answer.indirect).toBe(true);
  // Worker termination and generator returns unwind through catch.
  expect(computeMayThrow({ ...mod, workers: true }).fns).toContain("caught");
  const generator: IrFunction = {
    ...plain("caughtGenerator", [tryCatch([call("thrower")], [])]),
    generator: {} as unknown as NonNullable<IrFunction["generator"]>,
  };
  expect(computeMayThrow(moduleWith(...mod.functions, generator)).fns).toContain("caughtGenerator");
  // Explanations skip the handled path and name the rethrow.
  const explained = computeMayThrow(mod, { explain: true });
  expect(explained.why?.get("rethrows")).toMatchObject({ kind: "seed", what: "throw statement" });
});

test("completesNormally is conservative about abrupt completion", () => {
  const cond: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
  const ret: IrStmt = { kind: "return", value: null, loc };
  const brk: IrStmt = { kind: "break", loc };
  expect(completesNormally([])).toBe(true);
  expect(completesNormally([exprStmt(value), ret])).toBe(false);
  expect(completesNormally([brk])).toBe(false);
  expect(completesNormally([{ kind: "if", cond, then: [ret], else_: [brk], loc }])).toBe(false);
  expect(completesNormally([{ kind: "if", cond, then: [ret], else_: null, loc }])).toBe(true);
  expect(completesNormally([{ kind: "block", body: [ret], loc }])).toBe(false);
  // A labeled block can be the target of a break inside it.
  expect(
    completesNormally([
      { kind: "block", body: [{ kind: "break", label: "l", loc }], labels: ["l"], loc },
    ]),
  ).toBe(true);
  // A loop that runs forever completes only through a break that leaves it.
  expect(completesNormally([{ kind: "while", cond, body: [ret], loc }])).toBe(false);
  expect(completesNormally([{ kind: "while", cond, body: [brk], loc }])).toBe(true);
  expect(
    completesNormally([
      { kind: "while", cond, body: [{ kind: "while", cond, body: [brk], loc }, ret], loc },
    ]),
  ).toBe(false);
  const unknown: IrExpr = { kind: "varRef", localId: "flag", type: BOOL, loc };
  expect(completesNormally([{ kind: "while", cond: unknown, body: [ret], loc }])).toBe(true);
  const tryCatch = (catchBody: IrStmt[] | null, finallyBody: IrStmt[] | null = null): IrStmt => ({
    kind: "tryCatch",
    tryBody: [ret],
    catchBody,
    catchLocalId: null,
    finallyBody,
    loc,
  });
  expect(completesNormally([tryCatch([ret])])).toBe(false);
  expect(completesNormally([tryCatch([])])).toBe(true);
  expect(completesNormally([tryCatch(null, [])])).toBe(false);
  expect(completesNormally([tryCatch([], [ret])])).toBe(false);
  const kind: IrExpr = { kind: "numLit", value: 1, type: F64, loc };
  const switchOf = (cases: { test: IrExpr | null; body: IrStmt[] }[]): IrStmt => ({
    kind: "switch",
    disc: kind,
    cases,
    loc,
  });
  expect(
    completesNormally([
      switchOf([
        { test: kind, body: [] },
        { test: null, body: [ret] },
      ]),
    ]),
  ).toBe(false);
  expect(completesNormally([switchOf([{ test: kind, body: [ret] }])])).toBe(true);
  expect(
    completesNormally([
      switchOf([
        { test: kind, body: [brk] },
        { test: null, body: [ret] },
      ]),
    ]),
  ).toBe(true);
});

test("unreachable statements do not seed", () => {
  const ret: IrStmt = { kind: "return", value: null, loc };
  const trap: IrStmt = { kind: "runtimeFence", code: "SC9002", message: "unreachable", loc };
  const tryCatch: IrStmt = {
    kind: "tryCatch",
    tryBody: [exprStmt({ kind: "call", callee: "thrower", args: [], type: VOID, loc }), ret],
    catchBody: [ret],
    catchLocalId: null,
    finallyBody: null,
    loc,
  };
  const answer = computeMayThrow(
    moduleWith(
      fn("thrower", [{ kind: "throw", value, loc }], []),
      fn("caller", [tryCatch, trap], []),
      fn("reachable", [{ ...tryCatch, catchBody: [] }, trap], []),
    ),
  );
  expect([...answer.fns].sort()).toEqual(["reachable", "thrower"]);
});
