import { expect, test } from "vitest";
import { BOOL, F64, STRING, arrayOf, type IrExpr, type IrLocal, type IrStmt } from "./ir.js";
import {
  matchIntegerArrayForLoop,
  matchIntegerCountedForLoop,
  matchIntegerPairedForLoop,
} from "./integer-loops.js";

const loc = { file: "integer-array-loop.ts", start: 0, end: 0 };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const locals = new Map<string, IrLocal>([
  ["i", { id: "i", name: "i", type: F64, mutable: true }],
  ["a", { id: "a", name: "a", type: arrayOf(F64), mutable: false }],
]);
function loop(start = number(0)): IrStmt & { kind: "for" } {
  return {
    kind: "for",
    loc,
    init: { kind: "varDecl", localId: "i", init: start, loc },
    cond: {
      kind: "bin",
      op: "<",
      left: ref("i"),
      right: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: { kind: "varRef", localId: "a", type: arrayOf(F64), loc },
        args: [],
        type: F64,
        loc,
      },
      type: BOOL,
      loc,
    },
    update: {
      kind: "assign",
      localId: "i",
      value: { kind: "bin", op: "+", left: ref("i"), right: number(1), type: F64, loc },
      loc,
    },
    body: [],
  };
}

test("array length loops and active outer-array induction have exact integer bounds", () => {
  expect(matchIntegerArrayForLoop(loop(), locals, new Set())?.localId).toBe("i");
  const nested = loop({
    kind: "bin",
    op: "+",
    left: ref("outer"),
    right: number(1),
    type: F64,
    loc,
  });
  expect(matchIntegerArrayForLoop(nested, locals, new Set(["outer"]))?.localId).toBe("i");
  expect(matchIntegerArrayForLoop(nested, locals, new Set())).toBeNull();
});

test("negative zero, unknown starts, captured counters and body writes stay floating point", () => {
  for (const start of [number(-0), number(0.5), number(-1), ref("unknown")])
    expect(matchIntegerArrayForLoop(loop(start), locals, new Set())).toBeNull();
  const captured = new Map(locals);
  captured.set("i", { ...locals.get("i")!, boxed: true });
  expect(matchIntegerArrayForLoop(loop(), captured, new Set())).toBeNull();
  const changed = loop();
  changed.body.push({
    kind: "exprStmt",
    expr: { kind: "assignExpr", localId: "i", value: number(0.5), type: F64, loc },
    loc,
  });
  expect(matchIntegerArrayForLoop(changed, locals, new Set())).toBeNull();
});

test("changing the array length does not invalidate integer induction", () => {
  const changed = loop();
  changed.body.push({
    kind: "arraySetLength",
    arr: { kind: "varRef", localId: "a", type: arrayOf(F64), loc },
    length: number(0),
    loc,
  });
  expect(matchIntegerArrayForLoop(changed, locals, new Set())?.localId).toBe("i");
});

function counted(limit: IrExpr = number(4), inclusive = false): IrStmt & { kind: "for" } {
  const s = loop();
  s.cond = {
    kind: "bin",
    op: inclusive ? "<=" : "<",
    left: ref("i"),
    right: limit,
    type: BOOL,
    loc,
  };
  s.body = [
    {
      kind: "exprStmt",
      expr: { kind: "bin", op: "%", left: ref("i"), right: number(3), type: F64, loc },
      loc,
    },
  ];
  return s;
}

test("counted loops normalize finite literal limits and guard stable numeric locals", () => {
  for (const value of [0, -0, -1, 0.5, 4.5, -Infinity, 2 ** 53]) {
    expect(matchIntegerCountedForLoop(counted(number(value)), locals)?.guarded).toBe(false);
  }
  const withLimit = new Map(locals);
  withLimit.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  expect(matchIntegerCountedForLoop(counted(ref("limit"), true), withLimit)).toMatchObject({
    localId: "i",
    guarded: true,
    inclusive: true,
  });
  for (const value of [NaN, Infinity, 2 ** 53 + 2])
    expect(matchIntegerCountedForLoop(counted(number(value)), locals)).toBeNull();
  expect(matchIntegerCountedForLoop(counted(number(2 ** 53), true), locals)).toBeNull();
});

test("counted loop proofs reject writes, captures, effectful bounds and signed-zero starts", () => {
  const withLimit = new Map(locals);
  withLimit.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  for (const id of ["i", "limit"]) {
    const s = counted(ref("limit"));
    s.body.push({
      kind: "exprStmt",
      expr: { kind: "assignExpr", localId: id, value: number(2), type: F64, loc },
      loc,
    });
    expect(matchIntegerCountedForLoop(s, withLimit)).toBeNull();
    const captured = new Map(withLimit);
    captured.set(id, { ...captured.get(id)!, boxed: true });
    expect(matchIntegerCountedForLoop(counted(ref("limit")), captured)).toBeNull();
  }
  for (const value of [-0, 0.5, Infinity]) {
    const s = counted();
    s.init = { kind: "varDecl", localId: "i", init: number(value), loc };
    expect(matchIntegerCountedForLoop(s, locals)).toBeNull();
  }
  expect(
    matchIntegerCountedForLoop(
      counted({ kind: "incDec", localId: "limit", op: "+", prefix: false, type: F64, loc }),
      withLimit,
    ),
  ).toBeNull();
  expect(matchIntegerCountedForLoop(counted(ref("missing")), withLimit)).toBeNull();
});

test("versioning is bounded and requires an integer consumer", () => {
  const floating = counted();
  floating.body = [
    {
      kind: "exprStmt",
      expr: { kind: "bin", op: "+", left: ref("i"), right: number(0.5), type: F64, loc },
      loc,
    },
  ];
  expect(matchIntegerCountedForLoop(floating, locals)).toBeNull();
  const withLimit = new Map(locals);
  withLimit.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  const large = counted(ref("limit"));
  large.body = Array.from({ length: 81 }, () => large.body[0]!);
  expect(matchIntegerCountedForLoop(large, withLimit)).toBeNull();
  const nested = counted(ref("limit"));
  nested.body.push(counted());
  expect(matchIntegerCountedForLoop(nested, withLimit)).toBeNull();
  expect(matchIntegerCountedForLoop(counted(number(4)), locals)?.guarded).toBe(false);
});

test("an unproven start versions the loop on an exact integer start", () => {
  const withStart = new Map(locals);
  withStart.set("start", { id: "start", name: "start", type: F64, mutable: false });
  const s = counted(number(8));
  s.init = { kind: "varDecl", localId: "i", init: ref("start"), loc };
  expect(matchIntegerCountedForLoop(s, withStart)).toMatchObject({
    guarded: true,
    startGuarded: true,
    limitGuarded: false,
    range: { min: -Number.MAX_SAFE_INTEGER, max: 7 },
  });
  // The versioned body is duplicated, so the usual size bound applies.
  const large = counted(number(8));
  large.init = { kind: "varDecl", localId: "i", init: ref("start"), loc };
  large.body = Array.from({ length: 81 }, () => large.body[0]!);
  expect(matchIntegerCountedForLoop(large, withStart)).toBeNull();
});

test("a string read at the counter is an integer consumer", () => {
  const withText = new Map(locals);
  withText.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  withText.set("s", { id: "s", name: "s", type: STRING, mutable: false });
  const read = (index: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "strIntrinsic",
      method: "charCodeAt",
      receiver: { kind: "varRef", localId: "s", type: STRING, loc },
      args: [index],
      type: F64,
      loc,
    },
    loc,
  });
  const s = counted(ref("limit"));
  s.body = [read(ref("i"))];
  expect(matchIntegerCountedForLoop(s, withText)?.localId).toBe("i");
  s.body = [read({ kind: "bin", op: "+", left: ref("i"), right: number(1), type: F64, loc })];
  expect(matchIntegerCountedForLoop(s, withText)?.localId).toBe("i");
  // A read at another index does not consume the counter.
  s.body = [read(ref("limit"))];
  expect(matchIntegerCountedForLoop(s, withText)).toBeNull();
});

test("a string length bounds a counted loop while its binding is unchanged", () => {
  const withText = new Map(locals);
  withText.set("s", { id: "s", name: "s", type: STRING, mutable: true });
  const text = (): IrExpr => ({ kind: "varRef", localId: "s", type: STRING, loc });
  const length: IrExpr = {
    kind: "strIntrinsic",
    method: "length",
    receiver: text(),
    args: [],
    type: F64,
    loc,
  };
  const s = counted(length);
  s.body = [
    {
      kind: "exprStmt",
      expr: {
        kind: "strIntrinsic",
        method: "charCodeAt",
        receiver: text(),
        args: [ref("i")],
        type: F64,
        loc,
      },
      loc,
    },
  ];
  expect(matchIntegerCountedForLoop(s, withText)?.localId).toBe("i");
  // Rebinding the string in the body changes the length the condition reads.
  const rebinding = {
    ...s,
    body: [...s.body, { kind: "assign", localId: "s", value: text(), loc } as IrStmt],
  };
  expect(matchIntegerCountedForLoop(rebinding, withText)).toBeNull();
  const boxed = new Map(withText);
  boxed.set("s", { ...withText.get("s")!, boxed: true });
  expect(matchIntegerCountedForLoop(s, boxed)).toBeNull();
});

test("a stable array length bounds a counted loop; a resizing body keeps it a condition", () => {
  const ARR = arrayOf(F64);
  const array = (localId: string): IrExpr => ({ kind: "varRef", localId, type: ARR, loc });
  const length: IrExpr = {
    kind: "arrIntrinsic",
    method: "length",
    receiver: array("a"),
    args: [],
    type: F64,
    loc,
  };
  const read = (index: IrExpr): IrExpr => ({
    kind: "arrIntrinsic",
    method: "getNumber",
    receiver: array("a"),
    args: [index],
    type: F64,
    loc,
  });
  // for (let i = 0; i < a.length; i += 2) a[i];
  const strided = (body: IrStmt[]): IrStmt & { kind: "for" } => {
    const s = counted(length);
    s.update = {
      kind: "assign",
      localId: "i",
      value: { kind: "bin", op: "+", left: ref("i"), right: number(2), type: F64, loc },
      loc,
    };
    s.body = [{ kind: "exprStmt", expr: read(ref("i")), loc }, ...body];
    return s;
  };
  const ranges = new Map([[length, { min: 0, max: 4294967295 }]]);
  expect(matchIntegerCountedForLoop(strided([]), locals, ranges, new Set())).toMatchObject({
    localId: "i",
    guarded: false,
    range: { min: 0, max: 4294967294 },
  });
  // Without the alias facts there is no stability proof.
  expect(matchIntegerCountedForLoop(strided([]), locals, ranges)).toBeNull();
  const push: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "arrIntrinsic",
      method: "push",
      receiver: array("a"),
      args: [number(1)],
      type: F64,
      loc,
    },
    loc,
  };
  expect(matchIntegerCountedForLoop(strided([push]), locals, ranges, new Set())).toBeNull();
  // An element write at the counter stays below the length; one past it can grow the array.
  const write = (index: IrExpr): IrStmt => ({
    kind: "arraySet",
    arr: array("a"),
    index,
    value: number(0),
    loc,
  });
  expect(
    matchIntegerCountedForLoop(strided([write(ref("i"))]), locals, ranges, new Set()),
  ).not.toBeNull();
  const past = { kind: "bin", op: "+", left: ref("i"), right: number(1), type: F64, loc } as const;
  expect(matchIntegerCountedForLoop(strided([write(past)]), locals, ranges, new Set())).toBeNull();
});

test("a descending loop from an array's last index takes an integer counter for its reads", () => {
  const ARR = arrayOf(F64);
  const length: IrExpr = {
    kind: "arrIntrinsic",
    method: "length",
    receiver: { kind: "varRef", localId: "a", type: ARR, loc },
    args: [],
    type: F64,
    loc,
  };
  const start: IrExpr = { kind: "bin", op: "-", left: length, right: number(1), type: F64, loc };
  const s = loop(start);
  s.cond = { kind: "bin", op: ">=", left: ref("i"), right: number(0), type: BOOL, loc };
  s.update = {
    kind: "assign",
    localId: "i",
    value: { kind: "bin", op: "-", left: ref("i"), right: number(1), type: F64, loc },
    loc,
  };
  s.body = [
    {
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "getNumber",
        receiver: { kind: "varRef", localId: "a", type: ARR, loc },
        args: [ref("i")],
        type: F64,
        loc,
      },
      loc,
    },
  ];
  const ranges = new Map([[start, { min: -1, max: 4294967294 }]]);
  expect(matchIntegerCountedForLoop(s, locals, ranges)).toMatchObject({
    step: -1,
    guarded: false,
    range: { min: 0, max: 4294967294 },
  });
});

test("paired counters closing in on each other run as integers", () => {
  const vars = new Map(locals);
  for (const id of ["lo", "hi", "head"]) vars.set(id, { id, name: id, type: F64, mutable: true });
  const step = (id: string, op: "+" | "-", value = 1): IrStmt => ({
    kind: "assign",
    localId: id,
    value: { kind: "bin", op, left: ref(id), right: number(value), type: F64, loc },
    loc,
  });
  const element = (index: IrExpr): IrExpr => ({
    kind: "arrayGet",
    arr: { kind: "varRef", localId: "a", type: arrayOf(F64), loc },
    index,
    type: F64,
    loc,
  });
  const paired = (
    lowStart: IrExpr,
    highStart: IrExpr,
    update = [step("lo", "+"), step("hi", "-")],
  ) =>
    ({
      kind: "for",
      loc,
      init: {
        kind: "block",
        body: [
          { kind: "varDecl", localId: "lo", init: lowStart, loc },
          { kind: "varDecl", localId: "hi", init: highStart, loc },
        ],
        loc,
      },
      cond: { kind: "bin", op: "<", left: ref("lo"), right: ref("hi"), type: BOOL, loc },
      update: { kind: "block", body: update, loc },
      body: [{ kind: "exprStmt", expr: element(ref("hi")), loc }],
    }) as IrStmt & { kind: "for" };
  expect(matchIntegerPairedForLoop(paired(number(0), number(9)), vars)).toMatchObject({
    low: { localId: "lo", step: 1, startGuarded: false },
    high: { localId: "hi", step: -1, startGuarded: false },
    guarded: false,
    range: { min: 0, max: 9 },
  });
  // `hi > lo` and `hi >= lo` are `lo < hi` and `lo <= hi`.
  for (const op of [">", ">="] as const) {
    const reversed = paired(number(0), number(9));
    reversed.cond = { kind: "bin", op, left: ref("hi"), right: ref("lo"), type: BOOL, loc };
    expect(matchIntegerPairedForLoop(reversed, vars)).toMatchObject({
      low: { localId: "lo", step: 1 },
      high: { localId: "hi", step: -1 },
      inclusive: op === ">=",
    });
  }
  // A start without a known range is tested at run time.
  expect(matchIntegerPairedForLoop(paired(number(0), ref("head")), vars)).toMatchObject({
    high: { startGuarded: true },
    guarded: true,
  });
  // Counters moving the same way, written by the body, captured, started
  // from each other, or never used as an index are refused.
  expect(
    matchIntegerPairedForLoop(
      paired(number(0), number(9), [step("lo", "+"), step("hi", "+")]),
      vars,
    ),
  ).toBeNull();
  const writing = paired(number(0), number(9));
  writing.body.push(step("hi", "-", 2));
  expect(matchIntegerPairedForLoop(writing, vars)).toBeNull();
  const boxed = new Map(vars);
  boxed.set("hi", { ...vars.get("hi")!, boxed: true });
  expect(matchIntegerPairedForLoop(paired(number(0), number(9)), boxed)).toBeNull();
  expect(matchIntegerPairedForLoop(paired(number(0), ref("lo")), vars)).toBeNull();
  const unused = paired(number(0), number(9));
  unused.body = [];
  expect(matchIntegerPairedForLoop(unused, vars)).toBeNull();
});

test("counters stepped beside the tested one run as integers", () => {
  const vars = new Map(locals);
  for (const id of ["j", "k", "limit", "from"])
    vars.set(id, { id, name: id, type: F64, mutable: true });
  vars.set("s", { id: "s", name: "s", type: STRING, mutable: false });
  const step = (id: string, op: "+" | "-", value = 1): IrStmt => ({
    kind: "assign",
    localId: id,
    value: { kind: "bin", op, left: ref(id), right: number(value), type: F64, loc },
    loc,
  });
  const read = (index: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "strIntrinsic",
      method: "charCodeAt",
      receiver: { kind: "varRef", localId: "s", type: STRING, loc },
      args: [index],
      type: F64,
      loc,
    },
    loc,
  });
  const comoving = (
    limit: IrExpr,
    followerStart: IrExpr = number(0),
    update: IrStmt = { kind: "block", body: [step("i", "+"), step("j", "+", 4)], loc },
  ) =>
    ({
      kind: "for",
      loc,
      init: {
        kind: "block",
        body: [
          { kind: "varDecl", localId: "i", init: number(0), loc },
          { kind: "varDecl", localId: "j", init: followerStart, loc },
        ],
        loc,
      },
      cond: { kind: "bin", op: "<", left: ref("i"), right: limit, type: BOOL, loc },
      update,
      body: [read(ref("j"))],
    }) as IrStmt & { kind: "for" };
  // A literal limit bounds the follower: at most 9 updates of 4 before the
  // last body entry.
  expect(matchIntegerCountedForLoop(comoving(number(10)), vars)).toMatchObject({
    localId: "i",
    guarded: false,
    range: { min: 0, max: 9 },
    followers: [
      {
        localId: "j",
        step: 4,
        startGuarded: false,
        tripGuarded: false,
        range: { min: 0, max: 36 },
      },
    ],
  });
  // An unknown limit or start is tested at run time.
  expect(matchIntegerCountedForLoop(comoving(ref("limit")), vars)).toMatchObject({
    guarded: true,
    followers: [{ tripGuarded: true, range: { min: 0, max: 2 ** 52 + 2 } }],
  });
  expect(matchIntegerCountedForLoop(comoving(number(10), ref("from")), vars)).toMatchObject({
    guarded: true,
    followers: [{ startGuarded: true, tripGuarded: true }],
  });
  // A literal limit with known starts that can pass 2^53 is refused.
  expect(matchIntegerCountedForLoop(comoving(number(10), number(2 ** 53 - 9)), vars)).toBeNull();
  // Nested update blocks (`i++, j += 4, k--`) step three counters.
  const three = comoving(number(10), number(0), {
    kind: "block",
    body: [{ kind: "block", body: [step("i", "+"), step("j", "+", 4)], loc }, step("k", "-")],
    loc,
  });
  if (three.init?.kind === "block")
    three.init.body.push({ kind: "varDecl", localId: "k", init: number(5), loc });
  expect(matchIntegerCountedForLoop(three, vars)?.followers).toMatchObject([
    { localId: "j", range: { min: 0, max: 36 } },
    { localId: "k", step: -1, range: { min: -4, max: 5 } },
  ]);
  // A follower without a step, one the body writes, one the limit reads, a
  // captured one, and a start that reads another counter are refused.
  expect(
    matchIntegerCountedForLoop(
      comoving(number(10), number(0), { kind: "block", body: [step("i", "+")], loc }),
      vars,
    ),
  ).toBeNull();
  const writing = comoving(number(10));
  writing.body.push(step("j", "+"));
  expect(matchIntegerCountedForLoop(writing, vars)).toBeNull();
  expect(matchIntegerCountedForLoop(comoving(ref("j")), vars)).toBeNull();
  const boxed = new Map(vars);
  boxed.set("j", { ...vars.get("j")!, boxed: true });
  expect(matchIntegerCountedForLoop(comoving(number(10)), boxed)).toBeNull();
  expect(matchIntegerCountedForLoop(comoving(number(10), ref("i")), vars)).toBeNull();
  // A driver span above 2^53 - 1 bounds no trip count. From -(2^53 - 1) to
  // below 2^52 - 1 the span 3 * 2^52 - 3 rounds down to 3 * 2^52 - 4, which
  // would put this follower's last value at 2^53 - 1 instead of 2^53.
  const wide = comoving(number(2 ** 52 - 1), number(-(2 ** 52) + 3), {
    kind: "block",
    body: [step("i", "+"), step("j", "+")],
    loc,
  });
  if (wide.init?.kind === "block" && wide.init.body[0]?.kind === "varDecl")
    wide.init.body[0].init = number(-Number.MAX_SAFE_INTEGER);
  expect(matchIntegerCountedForLoop(wide, vars)).toBeNull();
  if (wide.init?.kind === "block" && wide.init.body[1]?.kind === "varDecl")
    wide.init.body[1].init = ref("from");
  expect(matchIntegerCountedForLoop(wide, vars)?.followers).toMatchObject([
    { startGuarded: true, tripGuarded: true },
  ]);
});

/** `counted(limit)` with the body `x = ((i + k) * (i + k + 1)) >>> 1`
 * inside a nested `for (let j = 0; j < 4; j++)` loop. */
function productLoop(limit: IrExpr, start: IrExpr = number(0)): IrStmt & { kind: "for" } {
  const s = counted(limit);
  if (s.init?.kind === "varDecl") s.init.init = start;
  const sum = (extra: number): IrExpr => {
    const base: IrExpr = { kind: "bin", op: "+", left: ref("i"), right: ref("k"), type: F64, loc };
    return extra === 0
      ? base
      : { kind: "bin", op: "+", left: base, right: number(extra), type: F64, loc };
  };
  const product: IrExpr = { kind: "bin", op: "*", left: sum(0), right: sum(1), type: F64, loc };
  const inner = counted(number(4));
  if (inner.init?.kind === "varDecl") inner.init.localId = "j";
  if (inner.cond?.kind === "bin") inner.cond.left = ref("j");
  if (inner.update?.kind === "assign") {
    inner.update.localId = "j";
    if (inner.update.value.kind === "bin") inner.update.value.left = ref("j");
  }
  inner.body = [
    {
      kind: "assign",
      localId: "x",
      value: { kind: "bin", op: ">>>", left: product, right: number(1), type: F64, loc },
      loc,
    },
  ];
  s.body = [inner];
  return s;
}

test("guarded counted loops whose products the counter bound proves exact may hold nested loops", () => {
  const scope = new Map(locals);
  for (const id of ["limit", "start", "k", "x", "j"])
    scope.set(id, { id, name: id, type: F64, mutable: true });
  const tight = matchIntegerCountedForLoop(productLoop(ref("limit"), ref("start")), scope);
  expect(tight).toMatchObject({
    guarded: true,
    limitGuarded: true,
    startGuarded: true,
    startBound: 2 ** 25,
    guardLimit: 2 ** 25,
    range: { min: -(2 ** 25), max: 2 ** 25 - 1 },
  });
  // A literal trip count past the bound keeps the safe-integer bound, and
  // a guarded loop under that bound holds no nested loop.
  expect(matchIntegerCountedForLoop(productLoop(number(1e9), ref("start")), scope)).toBeNull();
  const plain = counted(ref("limit"));
  plain.body = [productLoop(number(4)).body[0]!];
  const inner = plain.body[0] as IrStmt & { kind: "for" };
  inner.body = [
    {
      kind: "assign",
      localId: "x",
      value: { kind: "bin", op: "|", left: ref("i"), right: number(0), type: F64, loc },
      loc,
    },
  ];
  expect(matchIntegerCountedForLoop(plain, scope)).toBeNull();
  // Without a nested loop the product bound still applies to the limit.
  const flat = productLoop(ref("limit"), ref("start"));
  flat.body = (flat.body[0] as IrStmt & { kind: "for" }).body;
  expect(matchIntegerCountedForLoop(flat, scope)).toMatchObject({
    startBound: 2 ** 25,
    guardLimit: 2 ** 25,
  });
});
