import { expect, test } from "vitest";
import { JS_GROUP_KEYS, planJsGroups } from "./js-groups.js";
import type { JsIcSite } from "./js-ic.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 0 };

const local = (id: string, type = DYN, extra: Partial<IrLocal> = {}): IrLocal => ({
  id,
  name: id,
  type,
  mutable: true,
  ...extra,
});

const ref = (localId: string, type = DYN): IrExpr => ({ loc, kind: "varRef", localId, type });

const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });

/** A dynamic-tier property helper's call (`%dyn.class.property.N`). */
const read = (callee: string, subject: string): IrExpr => ({
  loc,
  kind: "call",
  callee,
  args: [ref(subject)],
  type: DYN,
});

const write = (callee: string, subject: string, value: IrExpr = boxed(1)): IrExpr => ({
  loc,
  kind: "call",
  callee,
  args: [ref(subject), value],
  type: VOID,
});

/** A static number boxed for a store. */
const boxed = (value: number): IrExpr => ({
  loc,
  kind: "dynFrom",
  value: num(value),
  type: DYN,
});

const sites: { site(callee: string): JsIcSite | null } = {
  site: (callee) => {
    const colon = callee.lastIndexOf(":");
    if (colon < 0) return null;
    const kind = callee.slice(0, colon);
    const key = callee.slice(colon + 1);
    if (kind === "keyed") return { kind: "keyed" };
    return { kind: kind === "set" ? "set" : "get", key };
  },
};

/** The site name of a constant-key read of `key`. */
const getOf = (key: string): string => `get:${key}`;
const setOf = (key: string): string => `set:${key}`;

const fnBody = (
  body: IrStmt[],
  locals: IrLocal[] = [
    local("item"),
    local("other"),
    local("out"),
    local("key", STRING),
    local("n", F64),
  ],
): IrFunction => ({
  loc,
  name: "cost",
  params: [{ localId: "item", name: "item", type: DYN }],
  locals,
  returnType: VOID,
  body,
});

const ret = (value: IrExpr): IrStmt => ({ loc, kind: "return", value });

const summarize = (fn: IrFunction) =>
  planJsGroups(fn, sites).groups.map((group) => ({
    subject: group.subject,
    keys: [...group.keys],
    members: group.members.map((m) => `${m.index}${m.recheck ? "r" : ""}${m.store ? "s" : ""}`),
  }));

test("reads of one subject in one statement form one group", () => {
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: read(getOf("price"), "item"),
      right: read(getOf("qty"), "item"),
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["price", "qty"], members: ["0", "1"] }]);
});

test("a single read is a site, not a group", () => {
  expect(summarize(fnBody([ret(read(getOf("price"), "item"))]))).toEqual([]);
});

test("reads of different subjects do not join", () => {
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: read(getOf("x"), "item"),
      right: read(getOf("x"), "other"),
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([]);
});

test("consecutive statements in a straight line share a run", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    {
      loc,
      kind: "exprStmt",
      expr: { loc, kind: "call", callee: "observe", args: [num(0)], type: VOID },
    },
    { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
  ]);
  // The call between the reads is a clobber, so the second one rechecks.
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "qty"], members: ["0", "1r"] },
  ]);
});

test("a member in one arm of an if does not join the run outside it", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    {
      loc,
      kind: "if",
      cond: { loc, kind: "boolLit", value: true, type: BOOL },
      then: [{ loc, kind: "exprStmt", expr: read(getOf("qty"), "item") }],
      else_: null,
    },
    { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
  ]);
  expect(summarize(fn)).toEqual([]);
});

test("an if's two arms are separate runs", () => {
  const fn = fnBody([
    {
      loc,
      kind: "if",
      cond: { loc, kind: "boolLit", value: true, type: BOOL },
      then: [
        { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
        { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
      ],
      else_: [
        { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
        { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
      ],
    },
  ]);
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "qty"], members: ["0", "1"] },
    { subject: "item", keys: ["price", "meta"], members: ["0", "1"] },
  ]);
});

test("a loop body's statements share a run that the condition does not join", () => {
  const fn = fnBody([
    {
      loc,
      kind: "while",
      cond: { loc, kind: "boolLit", value: true, type: BOOL },
      body: [
        { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
        { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
      ],
    },
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["price", "qty"], members: ["0", "1"] }]);
  const aroundLoop = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    {
      loc,
      kind: "while",
      cond: { loc, kind: "boolLit", value: true, type: BOOL },
      body: [{ loc, kind: "exprStmt", expr: read(getOf("qty"), "item") }],
    },
    { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
  ]);
  // Nothing crosses the loop's edges: each read stands alone.
  expect(summarize(aroundLoop)).toEqual([]);
});

test("a run does not continue past a jump", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    { loc, kind: "return", value: num(0) },
    { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
  ]);
  expect(summarize(fn)).toEqual([]);
});

test("a read in a return joins the run before it", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    { loc, kind: "return", value: read(getOf("qty"), "item") },
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["price", "qty"], members: ["0", "1"] }]);
});

test("try, catch and finally arms are separate runs", () => {
  const fn = fnBody([
    {
      loc,
      kind: "tryCatch",
      tryBody: [{ loc, kind: "exprStmt", expr: read(getOf("price"), "item") }],
      catchBody: [{ loc, kind: "exprStmt", expr: read(getOf("qty"), "item") }],
      catchLocalId: "err",
      finallyBody: [{ loc, kind: "exprStmt", expr: read(getOf("meta"), "item") }],
    },
  ]);
  expect(summarize(fn)).toEqual([]);
});

test("switch cases are separate runs", () => {
  const fn = fnBody([
    {
      loc,
      kind: "switch",
      disc: num(0),
      cases: [
        { test: num(0), body: [{ loc, kind: "exprStmt", expr: read(getOf("price"), "item") }] },
        { test: null, body: [{ loc, kind: "exprStmt", expr: read(getOf("qty"), "item") }] },
      ],
    },
  ]);
  expect(summarize(fn)).toEqual([]);
});

test("a block's statements are a straight line", () => {
  const fn = fnBody([
    {
      loc,
      kind: "block",
      body: [
        { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
        { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
      ],
    },
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["price", "qty"], members: ["0", "1"] }]);
});

test("a member inside a call's arguments stays clean up to the call", () => {
  // The argument is evaluated before the call, so it joins the run that
  // started before it; the call itself clobbers whatever follows.
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: read(getOf("price"), "item"),
      right: {
        loc,
        kind: "call",
        callee: "helper",
        args: [read(getOf("qty"), "item")],
        type: DYN,
      },
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["price", "qty"], members: ["0", "1"] }]);
});

test("a call's own read is not a member", () => {
  const plan = planJsGroups(
    fnBody([
      ret({
        loc,
        kind: "call",
        callee: "helper",
        args: [read(getOf("price"), "item")],
        type: DYN,
      }),
    ]),
    sites,
  );
  expect(plan.groups).toEqual([]);
});

test("a call inside the run marks the members after it", () => {
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: read(getOf("price"), "item"),
      right: {
        loc,
        kind: "bin",
        op: "+",
        left: { loc, kind: "call", callee: "touch", args: [ref("item")], type: VOID },
        right: read(getOf("meta"), "item"),
        type: DYN,
      },
      type: DYN,
    }),
  ]);
  // `price` is read before the call; `meta` after it, so it rechecks.
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "meta"], members: ["0", "1r"] },
  ]);
});

test("a neutral operation between members needs no recheck", () => {
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: {
        loc,
        kind: "bin",
        op: "*",
        left: read(getOf("price"), "item"),
        right: num(2),
        type: DYN,
      },
      right: read(getOf("qty"), "item"),
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["price", "qty"], members: ["0", "1"] }]);
});

test("a jsval arithmetic call between members marks the next member", () => {
  const arithmetic: IrExpr = {
    loc,
    kind: "libCall",
    fn: "js.arithmetic",
    args: [
      read(getOf("price"), "item"),
      read(getOf("qty"), "item"),
      { loc, kind: "strLit", value: "*", type: STRING },
    ],
    type: DYN,
  };
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: arithmetic,
      right: read(getOf("meta"), "item"),
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "qty", "meta"], members: ["0", "1", "2r"] },
  ]);
});

test("a branch between members ends the run on both sides", () => {
  const fn = fnBody([
    ret({
      loc,
      kind: "ternary",
      cond: { loc, kind: "boolLit", value: true, type: BOOL },
      then: read(getOf("price"), "item"),
      else_: read(getOf("qty"), "item"),
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([]);
  const after = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: read(getOf("price"), "item"),
      right: {
        loc,
        kind: "ternary",
        cond: { loc, kind: "boolLit", value: true, type: BOOL },
        then: read(getOf("qty"), "item"),
        else_: read(getOf("meta"), "item"),
        type: DYN,
      },
      type: DYN,
    }),
  ]);
  expect(summarize(after)).toEqual([]);
});

test("a reassigned or boxed subject is not grouped", () => {
  const reads = ret({
    loc,
    kind: "bin",
    op: "+",
    left: read(getOf("price"), "item"),
    right: read(getOf("qty"), "item"),
    type: DYN,
  });
  const reassigned = fnBody([reads, { loc, kind: "assign", localId: "item", value: ref("other") }]);
  expect(summarize(reassigned)).toEqual([]);
  const boxed = fnBody(
    [reads],
    [local("item", DYN, { boxed: true }), local("other"), local("out")],
  );
  expect(summarize(boxed)).toEqual([]);
  const initialized = fnBody([
    reads,
    { loc, kind: "assign", localId: "item", value: ref("other"), initializes: true },
  ]);
  expect(summarize(initialized)).toEqual([
    { subject: "item", keys: ["price", "qty"], members: ["0", "1"] },
  ]);
});

test("a store joins the run of the reads on its subject", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: write(setOf("qty"), "item", boxed(1)) },
    ret(read(getOf("qty"), "item")),
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["qty"], members: ["0s", "0"] }]);
});

test("a store of a value the group does not keep inert is a clobber", () => {
  for (const value of [
    { loc, kind: "call", callee: "pick", args: [], type: DYN } as IrExpr,
    { loc, kind: "dynFrom", value: ref("key", STRING), type: DYN, liveRef: true } as IrExpr,
  ]) {
    const fn = fnBody([
      { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
      { loc, kind: "exprStmt", expr: write(setOf("qty"), "item", value) },
      { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
    ]);
    // The store is a clobber, so the read after it checks the shape again.
    expect(summarize(fn)).toEqual([
      { subject: "item", keys: ["price", "meta"], members: ["0", "1r"] },
    ]);
  }
});

test("a store to an error-synchronized key is not a member", () => {
  for (const key of ["message", "name", "code", "cause", "stack"]) {
    const fn = fnBody([
      { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
      { loc, kind: "exprStmt", expr: write(setOf(key), "item") },
      { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
    ]);
    expect(summarize(fn)).toEqual([
      { subject: "item", keys: ["price", "meta"], members: ["0", "1r"] },
    ]);
  }
});

test("a store through a jsval word is a member", () => {
  const word: IrExpr = { loc, kind: "libCall", fn: "js.toDyn", args: [num(3)], type: DYN };
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: write(setOf("qty"), "item", word) },
    ret(read(getOf("qty"), "item")),
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["qty"], members: ["0s", "0"] }]);
});

test("a clean store leaves the members after it clean", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    { loc, kind: "exprStmt", expr: write(setOf("qty"), "item") },
    { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
  ]);
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "qty", "meta"], members: ["0", "1s", "2"] },
  ]);
});

test("a store after a clobber makes the members after it recheck", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    {
      loc,
      kind: "exprStmt",
      expr: { loc, kind: "call", callee: "observe", args: [num(0)], type: VOID },
    },
    { loc, kind: "exprStmt", expr: write(setOf("qty"), "item") },
    { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
  ]);
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "qty", "meta"], members: ["0", "1rs", "2r"] },
  ]);
});

test("every member after a clobber checks the shape again", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    {
      loc,
      kind: "exprStmt",
      expr: { loc, kind: "call", callee: "observe", args: [num(0)], type: VOID },
    },
    { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
    { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
  ]);
  // The first member after the call may take its own site's helper, which
  // leaves the group's entry behind the subject's layout; the member after
  // it cannot reuse the entry without checking the shape itself.
  expect(summarize(fn)).toEqual([
    { subject: "item", keys: ["price", "qty", "meta"], members: ["0", "1r", "2r"] },
  ]);
});

test("an assignment inside an operand keeps the binding out of groups", () => {
  const swap: IrExpr = {
    loc,
    kind: "assignExpr",
    localId: "item",
    value: ref("other"),
    type: DYN,
  };
  const nested: IrExpr[] = [
    { loc, kind: "call", callee: "use", args: [swap], type: VOID },
    { loc, kind: "bin", op: "+", left: num(1), right: swap, type: DYN },
    { loc, kind: "arrayLit", elems: [swap], type: { kind: "array", elem: DYN } },
  ];
  for (const expr of nested) {
    const fn = fnBody([
      { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
      { loc, kind: "exprStmt", expr },
      { loc, kind: "exprStmt", expr: read(getOf("qty"), "item") },
      { loc, kind: "exprStmt", expr: read(getOf("meta"), "item") },
    ]);
    // The binding names another object after the operand runs, so no read
    // of it can share a guard.
    expect(summarize(fn)).toEqual([]);
  }
});

test("a store to another binding does not join", () => {
  const fn = fnBody([
    { loc, kind: "exprStmt", expr: read(getOf("price"), "item") },
    { loc, kind: "exprStmt", expr: write(setOf("qty"), "other") },
  ]);
  expect(summarize(fn)).toEqual([]);
});

test("length, next and keyed reads are not members", () => {
  for (const callee of [getOf("length"), getOf("next"), "keyed:"]) {
    const fn = fnBody([
      ret({
        loc,
        kind: "bin",
        op: "+",
        left: read(callee, "item"),
        right: read(getOf("price"), "item"),
        type: DYN,
      }),
    ]);
    expect(summarize(fn)).toEqual([]);
  }
});

test("a run carries at most JS_GROUP_KEYS distinct keys", () => {
  let value: IrExpr = num(0);
  for (let i = 0; i < JS_GROUP_KEYS + 2; i++) {
    value = {
      loc,
      kind: "bin",
      op: "+",
      left: value,
      right: read(getOf(`k${i}`), "item"),
      type: DYN,
    };
  }
  const groups = summarize(fnBody([ret(value)]));
  expect(groups.map((g) => g.keys.length)).toEqual([JS_GROUP_KEYS, 2]);
  expect(groups[0]!.members).toHaveLength(JS_GROUP_KEYS);
});

test("repeated keys share one slot", () => {
  const fn = fnBody([
    ret({
      loc,
      kind: "bin",
      op: "+",
      left: read(getOf("tag"), "item"),
      right: read(getOf("tag"), "item"),
      type: DYN,
    }),
  ]);
  expect(summarize(fn)).toEqual([{ subject: "item", keys: ["tag"], members: ["0", "0"] }]);
});

test("the plan answers the group of each member site", () => {
  const first = read(getOf("price"), "item");
  const second = read(getOf("qty"), "item");
  const plan = planJsGroups(
    fnBody([ret({ loc, kind: "bin", op: "+", left: first, right: second, type: DYN })]),
    sites,
  );
  expect(plan.member(first)?.position).toBe(0);
  expect(plan.member(second)?.position).toBe(1);
  expect(plan.member(ref("item"))).toBeUndefined();
});
