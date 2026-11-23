/* node:test's mock functions (Node 24.22, lib/internal/test_runner/mock):
 * mock.fn, mock.method and their t.mock twins, the trackers' restoreAll
 * and reset, and the fn.mock context's calls, callCount,
 * mockImplementation, mockImplementationOnce, resetCalls and restore.
 *
 * mock.fn(original, implementation?) lowers to the hybrid record
 * { %call: wrapper, mock: context } (mock-shapes.ts). The wrapper is a
 * closure over the context, lifted once per context type: it takes the
 * one-time implementation registered for this call index, or the current
 * one, calls it, and appends { arguments, error, result, this } to the
 * calls log before returning or rethrowing. The context's mutating
 * methods are lifted helpers of the same type.
 *
 * mock.method(object, name, implementation?) mocks a function-valued field
 * of a record: the field gets a second wrapper over the same context, one
 * that records the object as `this`, and the context's %unmock closure
 * writes the original back on restore(). Each mock registers a closure
 * that calls its restore() with its tracker (scr_test.c): the module's
 * `mock`, or the test's t.mock, which is reset when the test ends. */
import { keyedHelperName } from "./stable-names.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  UNDEFINED_T,
  VOID,
  typeKey,
  type IrExpr,
  type IrLocal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { boolLit, countedFor, dynUndefinedExpr, numLit, strLit, varRef } from "../../ir/build.js";
import type { IrLibFn } from "../../ir/builtin-signatures.js";
import { mockContextType } from "../mock-shapes.js";
import { findMethodOn, type ClassInfo } from "./lower-classes.js";
import { funcTypeFromParamShapes } from "./call-signatures.js";
import { callableBox } from "./callable-properties.js";
import { locOf } from "../program.js";
import { resultIsDiscarded } from "./call-position.js";
import type { Lowerer } from "./lowerer.js";

type FuncType = IrType & { kind: "func" };

interface MockContextFields {
  fn: FuncType;
  call: IrType;
  calls: IrType;
  once: IrType;
  onceEntry: IrType;
  unmock: IrType;
  result: IrType;
  args: IrType;
  /** The { times } counter: -1 when the mock has none. */
  times: IrType;
}

const RESTORE_FN: IrType = { kind: "func", params: [], ret: VOID };

/** The context record's parts, or null when `type` is not a mock context
 * (mock-shapes.ts). */
function mockContextFields(lowerer: Lowerer, type: IrType): MockContextFields | null {
  if (type.kind !== "record") return null;
  const shape = lowerer.shapes.get(type.shapeId);
  const field = (name: string) => shape?.fields.find((f) => f.name === name)?.type;
  const impl = field("%impl");
  const once = field("%once");
  const calls = field("calls");
  const unmock = field("%unmock");
  const times = field("%times");
  if (
    impl?.kind !== "func" ||
    once?.kind !== "array" ||
    calls?.kind !== "array" ||
    unmock?.kind !== "array" ||
    times?.kind !== "f64" ||
    field("%original") === undefined
  )
    return null;
  const call = calls.elem;
  const callShape = call.kind === "record" ? lowerer.shapes.get(call.shapeId) : undefined;
  const result = callShape?.fields.find((f) => f.name === "result")?.type;
  const args = callShape?.fields.find((f) => f.name === "arguments")?.type;
  if (!result || !args) return null;
  return { fn: impl, call, calls, once, onceEntry: once.elem, unmock, result, args, times };
}

export function isMockContextType(lowerer: Lowerer, type: IrType): boolean {
  return mockContextFields(lowerer, type) !== null;
}

const recordGet = (obj: IrExpr, field: string, type: IrType, loc: SrcLoc): IrExpr => ({
  kind: "recordGet",
  obj,
  shapeId: (obj.type as IrType & { kind: "record" }).shapeId,
  field,
  type,
  loc,
});

const recordSet = (obj: IrExpr, field: string, value: IrExpr, loc: SrcLoc): IrStmt => ({
  kind: "recordSet",
  obj,
  shapeId: (obj.type as IrType & { kind: "record" }).shapeId,
  field,
  value,
  loc,
});

const length = (arr: IrExpr, loc: SrcLoc): IrExpr => ({
  kind: "arrIntrinsic",
  method: "length",
  receiver: arr,
  args: [],
  type: F64,
  loc,
});

const local = (id: string, name: string, type: IrType, mutable = false): IrLocal => ({
  id,
  name,
  type,
  mutable,
});

/** A captured local of a lifted closure. */
const boxedLocal = (id: string, name: string, type: IrType): IrLocal => ({
  ...local(id, name, type),
  boxed: true,
});

/** Lifts one function per (context type, role), cached on the lowerer.
 * `owner` overrides the context type's shape as the cache key. */
function liftOnce(
  lowerer: Lowerer,
  ctxType: IrType,
  role: string,
  build: (name: string) => void,
  owner: string = (ctxType as IrType & { kind: "record" }).shapeId,
): string {
  const key = `mock.${role}:${owner}`;
  const existing = lowerer.assertHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%mock.${role}`, key);
  lowerer.assertHelpers.set(key, name);
  build(name);
  return name;
}

/** `%mock.wrap.N(ctx)`: the closure that records each call into ctx and
 * runs the implementation with the receiver the call bound, which is
 * `undefined` for a bare call, exactly as Node's mock function does. The
 * wrapper a mock.method stores in an object's property is this same
 * closure: a member call of the mocked name passes its holder
 * (member-call-receivers.ts marks the name a `mock.method` call replaces),
 * so the receiver is the object the call went through, and a call of the
 * wrapper read off the object runs against whoever calls it. */
function mockWrapperFactory(lowerer: Lowerer, ctxType: IrType, loc: SrcLoc): string {
  return liftOnce(lowerer, ctxType, "wrap", (name) => {
    const { fn, call, calls, once, onceEntry, result, args } = mockContextFields(lowerer, ctxType)!;
    const impl = `${name}.impl`;
    const ctx = () => varRef("ctx.0", ctxType, loc);
    // A checked-dynamic rest function (mock.fn()'s default type) takes its
    // arguments as one trailing dyn array, recorded as the call's arguments
    // and spread into the implementation.
    const dynRest = fn.rest === true && fn.restAbi === undefined;
    const params = fn.params.map((type, i) => ({ localId: `p${i}.0`, name: `p${i}`, type }));
    if (dynRest) params.push({ localId: "rest.0", name: "args", type: DYN });
    const paramRefs = () => params.map((p) => varRef(p.localId, p.type, loc));
    const argumentsValue = (): IrExpr =>
      fn.rest
        ? paramRefs()[0]!
        : args.kind === "array"
          ? { kind: "arrayLit", elems: [], type: args, loc }
          : {
              kind: "recordLit",
              fields: paramRefs().map((value, i) => ({ name: String(i), value })),
              type: args,
              loc,
            };
    // The receiver this call bound: `o.m()` passes the object, `.call` and
    // `.apply` pass the one they name, and a bare call of the value passes
    // none, which Node records as undefined. A mock.method wrapper installed
    // in the object's property falls back to that object, because a typed
    // call of a member no function in the program reads passes no receiver.
    const callThis = (): IrExpr => varRef("rcv.0", DYN, loc);
    const record = (resultValue: IrExpr, error: IrExpr): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: recordGet(ctx(), "calls", calls, loc),
        args: [
          {
            kind: "recordLit",
            fields: [
              { name: "arguments", value: argumentsValue() },
              { name: "error", value: error },
              { name: "result", value: resultValue },
              {
                name: "this",
                value: callThis(),
              },
            ],
            type: call,
            loc,
          },
        ],
        type: F64,
        loc,
      },
      loc,
    });
    const voidReturn = fn.ret.kind === "void" || fn.ret.kind === "undefinedT";
    // The result slot: a checked-dynamic undefined for void functions, R
    // when R already admits undefined, else the `R | undefined` union.
    const asResult = (value: IrExpr | null): IrExpr => {
      if (result.kind === "dyn") return dynUndefinedExpr(loc);
      if (value !== null && result.kind === "union" && value.type.kind !== "union")
        return {
          kind: "unionWrap",
          unionId: result.unionId,
          tag: lowerer.armTag(result.unionId, value.type),
          value,
          type: result,
          loc,
        };
      if (value !== null) return value;
      const unionId = (result as IrType & { kind: "union" }).unionId;
      return {
        kind: "unionWrap",
        unionId,
        tag: lowerer.armTag(unionId, UNDEFINED_T),
        value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type: result,
        loc,
      };
    };
    // The wrapped method's implementation runs with the object as `this`,
    // exactly as Node's wrapper does: the method read off the object, or an
    // implementation the caller passed, sees the receiver the call bound.
    const invoke: IrExpr = dynRest
      ? {
          kind: "dynCall",
          callee: { kind: "dynFrom", value: varRef("f.0", fn, loc), type: DYN, loc },
          calleeName: "implementation",
          receiver: callThis(),
          args: paramRefs(),
          spreads: [{ arg: 0, what: "args" }],
          type: DYN,
          loc,
        }
      : {
          kind: "callValue",
          callee: varRef("f.0", fn, loc),
          receiver: callThis(),
          args: paramRefs(),
          type: fn.ret,
          loc,
        };
    const tryBody: IrStmt[] = voidReturn
      ? [
          { kind: "exprStmt", expr: invoke, loc },
          record(asResult(null), dynUndefinedExpr(loc)),
          { kind: "return", value: null, loc },
        ]
      : [
          { kind: "varDecl", localId: "r.0", init: invoke, loc },
          record(asResult(varRef("r.0", fn.ret, loc)), dynUndefinedExpr(loc)),
          { kind: "return", value: varRef("r.0", fn.ret, loc), loc },
        ];
    const catchBody: IrStmt[] = [
      record(asResult(null), {
        kind: "caughtToDyn",
        value: varRef("e.0", CAUGHT, loc),
        type: DYN,
        loc,
      }),
      { kind: "rethrow", localId: "e.0", loc },
    ];
    const onceArray = () => recordGet(ctx(), "%once", once, loc);
    const entry = (j: IrExpr): IrExpr => ({
      kind: "arrayGet",
      arr: onceArray(),
      index: j,
      type: onceEntry,
      loc,
    });
    // The one-time implementation for this call index, used once.
    const pickOnce = countedFor(loc, length(onceArray(), loc), (j) => [
      {
        kind: "if",
        cond: {
          kind: "bin",
          op: "===",
          left: recordGet(entry(j), "at", F64, loc),
          right: varRef("n.0", F64, loc),
          type: BOOL,
          loc,
        },
        then: [
          { kind: "assign", localId: "f.0", value: recordGet(entry(j), "fn", fn, loc), loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "arrIntrinsic",
              method: "splice",
              receiver: onceArray(),
              args: [j, numLit(1, loc)],
              type: once,
              loc,
            },
            loc,
          },
        ],
        else_: null,
        loc,
      },
    ]);
    // { times }: the mock's implementation serves this many calls; the call
    // whose index is one before the count restores the original, as Node's
    // nextImpl does (before the implementation runs).
    const timesField = () => recordGet(ctx(), "%times", F64, loc);
    const restoreOnTimes: IrStmt = {
      kind: "if",
      cond: {
        kind: "bin",
        op: "!==",
        left: timesField(),
        right: numLit(-1, loc),
        type: BOOL,
        loc,
      },
      then: [
        {
          kind: "if",
          cond: {
            kind: "bin",
            op: "===",
            left: {
              kind: "bin",
              op: "+",
              left: varRef("n.0", F64, loc),
              right: numLit(1, loc),
              type: F64,
              loc,
            },
            right: timesField(),
            type: BOOL,
            loc,
          },
          then: mockRestoreStmts(lowerer, ctxType, ctx, loc),
          else_: null,
          loc,
        },
      ],
      else_: null,
      loc,
    };
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: fn.ret,
      captures: [{ localId: "ctx.0", name: "ctx", type: ctxType }],
      locals: [
        ...params.map((p) => local(p.localId, p.name, p.type)),
        boxedLocal("ctx.0", "ctx", ctxType),
        local("rcv.0", "callThis", DYN),
        local("n.0", "index", F64),
        local("f.0", "implementation", fn, true),
        local("i.0", "entry", F64, true),
        ...(voidReturn ? [] : [local("r.0", "result", fn.ret)]),
        local("e.0", "error", CAUGHT),
      ],
      body: [
        {
          kind: "varDecl",
          localId: "rcv.0",
          init: { kind: "libCall", fn: "dyn.this", args: [], type: DYN, loc },
          loc,
        },
        {
          kind: "varDecl",
          localId: "n.0",
          init: length(recordGet(ctx(), "calls", calls, loc), loc),
          loc,
        },
        { kind: "varDecl", localId: "f.0", init: recordGet(ctx(), "%impl", fn, loc), loc },
        pickOnce,
        restoreOnTimes,
        { kind: "tryCatch", tryBody, catchBody, catchLocalId: "e.0", finallyBody: null, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "ctx.0", name: "ctx", type: ctxType }],
      returnType: fn,
      locals: [boxedLocal("ctx.0", "ctx", ctxType)],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: impl,
            captures: ["ctx.0"],
            type: fn,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  });
}

/** `%mock.restore.N(ctx)`: fn.mock.restore(). A method mock writes the
 * original back to its object and keeps its implementation; a mock.fn mock
 * goes back to its original implementation. */
/** The statements a mock's restore runs: a method mock writes its original
 * back to the object, and a mock.fn mock goes back to its original
 * implementation. */
function mockRestoreStmts(lowerer: Lowerer, ctxType: IrType, ctx: () => IrExpr, loc: SrcLoc) {
  const { fn, unmock } = mockContextFields(lowerer, ctxType)!;
  const unmockArray = () => recordGet(ctx(), "%unmock", unmock, loc);
  return [
    {
      kind: "if",
      cond: {
        kind: "bin",
        op: "===",
        left: length(unmockArray(), loc),
        right: numLit(0, loc),
        type: BOOL,
        loc,
      },
      then: [recordSet(ctx(), "%impl", recordGet(ctx(), "%original", fn, loc), loc)],
      else_: [
        {
          kind: "exprStmt",
          expr: {
            kind: "callValue",
            callee: {
              kind: "arrayGet",
              arr: unmockArray(),
              index: numLit(0, loc),
              type: RESTORE_FN,
              loc,
            },
            args: [],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
      loc,
    },
  ] satisfies IrStmt[];
}

function mockRestoreHelper(lowerer: Lowerer, ctxType: IrType, loc: SrcLoc): string {
  return mockHelper(
    lowerer,
    ctxType,
    "restore",
    [],
    (ctx) => mockRestoreStmts(lowerer, ctxType, ctx, loc),
    loc,
  );
}

/** `%mock.tracked.N(ctx)`: the closure a tracker keeps, which calls the
 * mock's restore(). */
function mockTrackedFactory(lowerer: Lowerer, ctxType: IrType, loc: SrcLoc): string {
  const restore = mockRestoreHelper(lowerer, ctxType, loc);
  return liftOnce(lowerer, ctxType, "tracked", (name) => {
    const impl = `${name}.impl`;
    lowerer.liftedFns.push({
      name: impl,
      params: [],
      returnType: VOID,
      captures: [{ localId: "ctx.0", name: "ctx", type: ctxType }],
      locals: [boxedLocal("ctx.0", "ctx", ctxType)],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "call",
            callee: restore,
            args: [varRef("ctx.0", ctxType, loc)],
            type: VOID,
            loc,
          },
          loc,
        },
        { kind: "return", value: null, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "ctx.0", name: "ctx", type: ctxType }],
      returnType: RESTORE_FN,
      locals: [boxedLocal("ctx.0", "ctx", ctxType)],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: ["ctx.0"], type: RESTORE_FN, loc },
          loc,
        },
      ],
      loc,
    });
  });
}

/** `%mock.unmock.N(object, original)`: the closure that writes `original`
 * back to the object's field. */
function mockUnmockFactory(
  lowerer: Lowerer,
  ctxType: IrType,
  objType: IrType & { kind: "record" },
  field: string,
  loc: SrcLoc,
): string {
  const { fn } = mockContextFields(lowerer, ctxType)!;
  return liftOnce(
    lowerer,
    ctxType,
    "unmock",
    (name) => {
      const impl = `${name}.impl`;
      const captures = [
        { localId: "obj.0", name: "object", type: objType as IrType },
        { localId: "orig.0", name: "original", type: fn as IrType },
      ];
      const boxedLocals = captures.map((c) => boxedLocal(c.localId, c.name, c.type));
      lowerer.liftedFns.push({
        name: impl,
        params: [],
        returnType: VOID,
        captures,
        locals: boxedLocals,
        body: [
          recordSet(varRef("obj.0", objType, loc), field, varRef("orig.0", fn, loc), loc),
          { kind: "return", value: null, loc },
        ],
        loc,
      });
      lowerer.liftedFns.push({
        name,
        params: captures,
        returnType: RESTORE_FN,
        locals: boxedLocals,
        body: [
          {
            kind: "return",
            value: {
              kind: "closure",
              fnName: impl,
              captures: ["obj.0", "orig.0"],
              type: RESTORE_FN,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    },
    `${objType.shapeId}.${JSON.stringify(field)}`,
  );
}

/** `%mock.unmockDyn.N(receiver, original)`: the closure that writes the
 * original method value back to a class instance's or prototype object's
 * property, the way the assignment Node's restore performs would. */
function mockDynUnmockFactory(
  lowerer: Lowerer,
  ctxType: IrType,
  field: string,
  loc: SrcLoc,
): string {
  return liftOnce(lowerer, ctxType, `unmockDyn:${JSON.stringify(field)}`, (name) => {
    const impl = `${name}.impl`;
    const captures = [
      { localId: "recv.0", name: "receiver", type: DYN },
      { localId: "orig.0", name: "original", type: DYN },
    ];
    const boxedLocals = captures.map((c) => boxedLocal(c.localId, c.name, c.type));
    const write: IrStmt = {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [varRef("recv.0", DYN, loc), strLit(field, loc), varRef("orig.0", DYN, loc)],
        type: VOID,
        loc,
      },
      loc,
    };
    lowerer.liftedFns.push({
      name: impl,
      params: [],
      returnType: VOID,
      captures,
      locals: boxedLocals,
      body: [write, { kind: "return", value: null, loc }],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: captures,
      returnType: RESTORE_FN,
      locals: boxedLocals,
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: impl,
            captures: ["recv.0", "orig.0"],
            type: RESTORE_FN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  });
}

/** A VOID helper over the context: `%mock.<role>.N(ctx, ...extra)`. */
function mockHelper(
  lowerer: Lowerer,
  ctxType: IrType,
  role: string,
  extra: { id: string; name: string; type: IrType }[],
  body: (ctx: () => IrExpr, loc: SrcLoc) => IrStmt[],
  loc: SrcLoc,
): string {
  return liftOnce(lowerer, ctxType, role, (name) => {
    const ctx = () => varRef("ctx.0", ctxType, loc);
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "ctx.0", name: "ctx", type: ctxType },
        ...extra.map((e) => ({ localId: e.id, name: e.name, type: e.type })),
      ],
      returnType: VOID,
      locals: [
        local("ctx.0", "ctx", ctxType),
        ...extra.map((e) => local(e.id, e.name, e.type, true)),
        local("i.0", "entry", F64, true),
      ],
      body: [...body(ctx, loc), { kind: "return", value: null, loc }],
      loc,
    });
  });
}

/** The lowered TestContext of a t.mock call, or null for the module's
 * `mock`. */
export type MockTracker = IrExpr | null;

/** Registers a mock's restore with its tracker. */
function trackMock(
  lowerer: Lowerer,
  tracker: MockTracker,
  ctxType: IrType,
  ctx: IrExpr,
  loc: SrcLoc,
): IrStmt {
  const restore: IrExpr = {
    kind: "call",
    callee: mockTrackedFactory(lowerer, ctxType, loc),
    args: [ctx],
    type: RESTORE_FN,
    loc,
  };
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: tracker ? "test.ctxMockTrack" : "test.mockTrack",
      args: tracker ? [tracker, restore] : [restore],
      type: VOID,
      loc,
    },
    loc,
  };
}

/** The context record literal of a new mock. */
function mockContextLiteral(
  ctxType: IrType,
  fields: MockContextFields,
  implementation: IrExpr,
  original: IrExpr,
  unmock: IrExpr[],
  times: IrExpr,
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "recordLit",
    fields: [
      { name: "%impl", value: implementation },
      { name: "%once", value: { kind: "arrayLit", elems: [], type: fields.once, loc } },
      { name: "%original", value: original },
      { name: "%unmock", value: { kind: "arrayLit", elems: unmock, type: fields.unmock, loc } },
      { name: "%times", value: times },
      { name: "calls", value: { kind: "arrayLit", elems: [], type: fields.calls, loc } },
    ],
    type: ctxType,
    loc,
  };
}

/** The Mock<F> value: the wrapper closure, carrying its context as the
 * `mock` own property of the function. That is the one representation Node
 * gives `Mock<F> = F & { mock }` — the mock IS the function object, so
 * `typeof` answers "function" and every alias observes the same context.
 * Node serves the context through a proxy: it is invisible to `Object.keys`
 * and answers only on a read of `mockFn.mock`. The property is therefore
 * defined with a non-enumerable data descriptor rather than stored as an
 * enumerable table entry, so `Object.keys` stays empty. A proxy has no own
 * property to report, so Node answers `"mock" in mockFn` false and
 * `Object.getOwnPropertyNames` without it; an own property answers the
 * other way. That reflection difference is the documented divergence.
 * The wrapper goes into a hidden local so the descriptor and the result
 * name the same closure. */
function defineMockProps(
  lowerer: Lowerer,
  stmts: IrStmt[],
  call: ts.CallExpression,
  wrapper: IrExpr,
  ctx: IrExpr,
  loc: SrcLoc,
): void {
  const boxed = callableBox(lowerer, wrapper);
  if (!boxed) {
    lowerer.noLowering(
      "mock functions of this type",
      call,
      "the wrapper closure must be boxable as an object to carry the mock context",
    );
  }
  const dyn = (value: IrExpr): IrExpr => lowerer.coerceToExpected(value, DYN);
  const flag = (value: boolean): IrExpr => ({
    kind: "dynFrom",
    value: { kind: "boolLit", value, type: BOOL, loc },
    type: DYN,
    loc,
  });
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [
        boxed,
        dyn(strLit("mock", loc)),
        {
          kind: "dynObjLit",
          fields: [
            { key: strLit("value", loc), value: dyn(ctx) },
            { key: strLit("writable", loc), value: flag(true) },
            { key: strLit("enumerable", loc), value: flag(false) },
            { key: strLit("configurable", loc), value: flag(true) },
          ],
          type: DYN,
          loc,
        },
      ],
      type: DYN,
      loc,
    },
    loc,
  });
}

/** A union return type needs an undefined arm: the calls log records
 * undefined for calls that throw. */
function requireUndefinedResultArm(
  lowerer: Lowerer,
  fields: MockContextFields,
  call: ts.CallExpression,
  what: string,
): void {
  if (fields.fn.ret.kind === "union" && typeKey(fields.result) !== typeKey(fields.fn.ret)) {
    lowerer.noLowering(
      `${what} of a function returning '${lowerer.fmt(fields.fn.ret)}'`,
      call,
      "a union return type needs an undefined arm here (the calls log records undefined for calls that throw)",
    );
  }
}

/** `%mock.noop.N`: mock.fn()'s original, Node's `function () {}` — it
 * returns undefined. Null when the function type's return type cannot hold
 * undefined. */
function mockNoopOriginal(
  lowerer: Lowerer,
  ctxType: IrType,
  fn: FuncType,
  loc: SrcLoc,
): IrExpr | null {
  const voidReturn = fn.ret.kind === "void" || fn.ret.kind === "undefinedT";
  const undefinedValue = voidReturn ? null : lowerer.wrappedUndefined(fn.ret, loc);
  if (!voidReturn && !undefinedValue) return null;
  const name = liftOnce(lowerer, ctxType, "noop", (name) => {
    const params = fn.params.map((type, i) => ({ localId: `p${i}.0`, name: `p${i}`, type }));
    if (fn.rest === true && fn.restAbi === undefined)
      params.push({ localId: "rest.0", name: "args", type: DYN });
    lowerer.liftedFns.push({
      name,
      params,
      returnType: fn.ret,
      locals: params.map((p) => local(p.localId, p.name, p.type)),
      body: [{ kind: "return", value: undefinedValue, loc }],
      loc,
    });
  });
  return { kind: "closure", fnName: name, captures: [], type: fn, loc };
}

/** mock.fn(original?, implementation?) and t.mock.fn(...). Without an
 * original, the mock's original and implementation are a function that
 * returns undefined, as in Node. */
/** The mock options object's { times }: the number of calls the mock's
 * implementation serves before the original comes back, -1 without the
 * option (Node's Infinity). A numeric literal is checked against Node's
 * non-negative-integer rule here; an expression is passed through. Other
 * options (getter and setter) fence. */
function mockTimesOption(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  what: string,
  loc: SrcLoc,
): { times: IrExpr; check: IrStmt[] } {
  if (node === undefined) return { times: numLit(-1, loc), check: [] };
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      `${what} options that are not an object literal`,
      node,
      "pass the options as an object literal: { times?: number }",
    );
  }
  let times: IrExpr | null = null;
  for (const prop of node.properties.nodes) {
    if (
      !(ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) &&
      !ts.isShorthandPropertyAssignment(prop)
    ) {
      lowerer.noLowering(
        `${what} options with computed keys or spreads`,
        prop,
        "each option must be a `name: value` or shorthand entry with a literal key",
      );
    }
    const name = (prop.name as ts.Identifier).text;
    if (name !== "times") {
      lowerer.noLowering(`${what} option '${name}'`, prop, "times is the supported mock option");
    }
    const init: ts.Expression = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : (prop.name as ts.Identifier);
    if (ts.isNumericLiteral(init)) {
      times = numLit(Number(init.text), loc);
    } else if (lowerer.mapTypeOf(lowerer.typeOf(init))?.kind === "f64") {
      times = lowerer.lowerExprExpecting(init, F64);
    } else {
      lowerer.noLowering(
        `${what} with a non-number times value`,
        init,
        "times takes a non-negative number",
      );
    }
  }
  if (!times) return { times: numLit(-1, loc), check: [] };
  /* Node validates the count when the mock is created, so a bad one throws
   * there (ERR_OUT_OF_RANGE) instead of at the first call. The check runs
   * where the caller places it: after the earlier arguments, as Node
   * evaluates the call's arguments left to right before the mock is set up. */
  const slot = lowerer.declareHiddenLocal("%mockTimes", F64);
  return {
    times: varRef(slot.id, F64, loc),
    check: [
      {
        kind: "varDecl",
        localId: slot.id,
        init: { kind: "libCall", fn: "test.mockTimes", args: [times], type: F64, loc },
        loc,
      },
    ],
  };
}

export function lowerMockFn(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
  tracker: MockTracker,
): IrExpr {
  const loc = locOf(call);
  // `Mock<F>` maps to F's func type: the mock IS the wrapper closure.
  const mockType = lowerer.mapTypeOf(lowerer.typeOf(call));
  const fn = mockType?.kind === "func" ? mockType : null;
  const ctxType = fn ? mockContextType(fn, lowerer.typeCtx) : null;
  if (!fn || !ctxType || !isMockContextType(lowerer, ctxType)) {
    lowerer.noLowering(
      `${what} of this function type`,
      call,
      "mock functions lower for functions with fixed parameters, or a single rest array parameter, and an implementation of the same type",
    );
  }
  const fields = mockContextFields(lowerer, ctxType!)!;
  requireUndefinedResultArm(lowerer, fields, call, what);
  const args = call.arguments.nodes;
  const isOptions = (arg: ts.Expression | undefined): boolean =>
    arg !== undefined &&
    ts.isObjectLiteralExpression(arg) &&
    lowerer.checker.getCallSignatures(lowerer.typeOf(arg)).length === 0;
  const hasOptions = args.length > 1 && isOptions(args.at(-1));
  const optionCount = hasOptions ? 1 : 0;
  if (args.length - optionCount > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      call,
      "the supported forms are mock.fn(), mock.fn(original), mock.fn(original, implementation), each with a trailing { times } options object",
    );
  }
  const stmts: IrStmt[] = [];
  const timesOption = mockTimesOption(lowerer, hasOptions ? args.at(-1) : undefined, what, loc);
  const valueArgs = args.length - optionCount;
  const noop = valueArgs === 0 ? mockNoopOriginal(lowerer, ctxType!, fn, loc) : null;
  if (valueArgs === 0 && !noop) {
    lowerer.noLowering(
      `${what}() of a function returning '${lowerer.fmt(fn.ret)}'`,
      call,
      "mock.fn() without an original returns undefined: pass an original, or use a function type whose return type includes undefined",
    );
  }
  const originalLocal = lowerer.declareHiddenLocal("%mockOriginal", fn);
  stmts.push({
    kind: "varDecl",
    localId: originalLocal.id,
    init: noop ?? lowerer.lowerExprExpecting(args[0]!, fn),
    loc,
  });
  /* The implementation evaluates after the original and before the options,
   * as the call's arguments do in Node. */
  const implLocal = lowerer.declareHiddenLocal("%mockImplementation", fn);
  stmts.push({
    kind: "varDecl",
    localId: implLocal.id,
    init:
      valueArgs === 2
        ? lowerer.lowerExprExpecting(args[1]!, fn)
        : varRef(originalLocal.id, fn, loc),
    loc,
  });
  stmts.push(...timesOption.check);
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  const ctx = () => varRef(ctxLocal.id, ctxType!, loc);
  stmts.push(
    {
      kind: "varDecl",
      localId: ctxLocal.id,
      init: mockContextLiteral(
        ctxType!,
        fields,
        varRef(implLocal.id, fn, loc),
        varRef(originalLocal.id, fn, loc),
        [],
        timesOption.times,
        loc,
      ),
      loc,
    },
    trackMock(lowerer, tracker, ctxType!, ctx(), loc),
  );
  const wrapperLocal = lowerer.declareHiddenLocal("%mockWrapper", fn);
  stmts.push({
    kind: "varDecl",
    localId: wrapperLocal.id,
    init: {
      kind: "call",
      callee: mockWrapperFactory(lowerer, ctxType!, loc),
      args: [ctx()],
      type: fn,
      loc,
    },
    loc,
  });
  const wrapper = varRef(wrapperLocal.id, fn, loc);
  defineMockProps(lowerer, stmts, call, wrapper, ctx(), loc);
  return { kind: "seqExpr", stmts, result: wrapper, type: fn, loc };
}

/** The class a mock.method receiver names: an instance's class, or the
 * class a `C.prototype` object belongs to. Null for every other value. */
function mockClassReceiver(lowerer: Lowerer, receiver: ts.Expression): ClassInfo | null {
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(receiver));
  if (mapped?.kind === "object") return lowerer.classes.get(mapped.className) ?? null;
  let base: ts.Expression = receiver;
  while (ts.isParenthesizedExpression(base)) base = base.expression;
  if (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === "prototype" &&
    ts.isIdentifier(base.expression)
  ) {
    const symbol = lowerer.resolveValueSymbol(base.expression);
    return symbol ? (lowerer.classBySymbol.get(symbol) ?? null) : null;
  }
  return null;
}

/** The declared type of method `method` of the class `receiver` names. */
function mockClassMethodType(
  lowerer: Lowerer,
  receiver: ts.Expression,
  method: string,
): FuncType | null {
  const info = mockClassReceiver(lowerer, receiver);
  if (info === null) return null;
  const found = findMethodOn(lowerer, info, method);
  if (!found || found.sig.abstract) return null;
  const type = funcTypeFromParamShapes(found.sig.params, found.sig.ret);
  return type.kind === "func" ? type : null;
}

const METHOD_HINT =
  "mock.method lowers for an object literal or interface-typed object (a record), a class instance, or a class's prototype object, with a method named by a string literal";

/** mock.method(object, methodName, implementation?) and t.mock.method. The
 * field's function type F is the mock's type; an implementation must have
 * the same type, unless the call's result is discarded. */
export function lowerMockMethod(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
  tracker: MockTracker,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (args.length < 2 || args.length > 4 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      call,
      "the supported forms are mock.method(object, methodName), mock.method(object, methodName, implementation) and the same with a trailing { times } options object",
    );
  }
  const nameArg = args[1]!;
  if (!ts.isStringLiteralLike(nameArg)) {
    lowerer.noLowering(`${what} with a computed method name`, nameArg, METHOD_HINT);
  }
  const field = (nameArg as ts.StringLiteralLike).text;
  const isOptions = (arg: ts.Expression | undefined): boolean =>
    arg !== undefined &&
    ts.isObjectLiteralExpression(arg) &&
    lowerer.checker.getCallSignatures(lowerer.typeOf(arg)).length === 0;
  const trailing = args[2];
  const implementationNode = trailing === undefined || isOptions(trailing) ? undefined : trailing;
  const implArg = lowerMockImplementationArg(lowerer, implementationNode);
  const implementation = implArg && "lowered" in implArg ? implArg : null;
  const optionsNode = args.length === 4 ? args[3] : isOptions(trailing) ? trailing : undefined;
  if (args.length === 4 && trailing !== undefined && isOptions(trailing)) {
    lowerer.noLowering(
      `${what} with an options object before its implementation`,
      trailing,
      "pass the implementation, then the { times } options object",
    );
  }
  if (optionsNode !== undefined && !isOptions(optionsNode)) {
    lowerer.noLowering(
      `${what} options that are not an object literal`,
      optionsNode,
      "pass the options as an object literal: { times?: number }",
    );
  }
  const stmts: IrStmt[] = [];
  const timesOption = mockTimesOption(lowerer, optionsNode, what, loc);
  const objType = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
  const objShape = objType?.kind === "record" ? lowerer.shapes.get(objType.shapeId) : undefined;
  const recordField = objShape?.fields.find((f) => f.name === field)?.type;
  // A class instance and a class's prototype object keep their methods in
  // the class's property machinery, where an own property shadows the
  // declared method. Their method's type is the declaration's, and the
  // property is read and written through the checked-dynamic receiver so
  // the write reaches every call site of the class.
  const classFn =
    recordField?.kind === "func" ? null : mockClassMethodType(lowerer, args[0]!, field);
  const fn = recordField?.kind === "func" ? recordField : classFn;
  if (!objType || fn === null) {
    const typeName = ts.symbolNameOf(lowerer.typeOf(args[0]!).getSymbol());
    lowerer.noLowering(
      typeName && !typeName.startsWith("__")
        ? `${what} on '${typeName}'`
        : `${what} on this object`,
      args[0]!,
      METHOD_HINT,
    );
  }
  const dynamicObject = recordField?.kind !== "func";
  const ctxType = mockContextType(fn as FuncType, lowerer.typeCtx);
  if (!ctxType || !isMockContextType(lowerer, ctxType)) {
    lowerer.noLowering(
      `${what} of a '${lowerer.fmt(fn!)}' method`,
      call,
      "mock functions lower for functions with fixed parameters, or a single rest array parameter",
    );
  }
  if (!resultIsDiscarded(call)) {
    const resultType = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (!resultType || typeKey(resultType) !== typeKey(fn)) {
      lowerer.noLowering(
        `${what} with an implementation of another type`,
        implementationNode ?? call,
        "give the implementation the method's parameter and return types, or discard the result",
      );
    }
  }
  const fields = mockContextFields(lowerer, ctxType!)!;
  requireUndefinedResultArm(lowerer, fields, call, what);
  // A class instance or a prototype object is held as the checked-dynamic
  // value whose property write shadows the method for every compiled call
  // site; a record is held at its own type.
  const objLocal = lowerer.declareHiddenLocal("%mockObject", dynamicObject ? DYN : objType!);
  const obj = () => varRef(objLocal.id, objLocal.type!, loc);
  stmts.push({
    kind: "varDecl",
    localId: objLocal.id,
    init: dynamicObject
      ? lowerer.coerceToExpected(lowerer.lowerExpr(args[0]!), DYN)
      : lowerer.lowerExpr(args[0]!),
    loc,
  });
  const key = (): IrExpr => strLit(field, loc);
  const originalLocal = lowerer.declareHiddenLocal("%mockOriginal", fn!);
  const original = () => varRef(originalLocal.id, fn!, loc);
  const originalDynLocal = dynamicObject
    ? lowerer.declareHiddenLocal("%mockOriginalDyn", DYN)
    : null;
  const originalDyn = (): IrExpr => varRef(originalDynLocal!.id, DYN, loc);
  /* The call's arguments evaluate before the mock reads the current field:
   * the implementation (or an undefined-answering expression, for its
   * effects) and the { times } option run before the field is read, so a
   * field they replace is the one the mock captures and restores. */
  const implLocal = lowerer.declareHiddenLocal("%mockImplementation", fn!);
  if (implArg && "unit" in implArg) stmts.push({ kind: "exprStmt", expr: implArg.unit, loc });
  if (implementation !== null)
    stmts.push({
      kind: "varDecl",
      localId: implLocal.id,
      init: lowerer.coerceToExpected(implementation.lowered, fn!),
      loc,
    });
  stmts.push(...timesOption.check);
  if (originalDynLocal) {
    // The method the property answers now, as the value Node restores.
    stmts.push({
      kind: "varDecl",
      localId: originalDynLocal.id,
      init: { kind: "dynKeyGet", value: obj(), key: key(), type: DYN, loc },
      loc,
    });
    stmts.push({
      kind: "varDecl",
      localId: originalLocal.id,
      init: lowerer.coerceInto(call, originalDyn(), fn!),
      loc,
    });
  } else {
    stmts.push({
      kind: "varDecl",
      localId: originalLocal.id,
      init: recordGet(obj(), field, fn!, loc),
      loc,
    });
  }
  if (implementation === null)
    stmts.push({
      kind: "varDecl",
      localId: implLocal.id,
      init: original(),
      loc,
    });
  const unmock: IrExpr = {
    kind: "call",
    callee: dynamicObject
      ? mockDynUnmockFactory(lowerer, ctxType!, field, loc)
      : mockUnmockFactory(lowerer, ctxType!, objType as IrType & { kind: "record" }, field, loc),
    args: dynamicObject ? [obj(), originalDyn()] : [obj(), original()],
    type: RESTORE_FN,
    loc,
  };
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  const ctx = () => varRef(ctxLocal.id, ctxType!, loc);
  stmts.push(
    {
      kind: "varDecl",
      localId: ctxLocal.id,
      init: mockContextLiteral(
        ctxType!,
        fields,
        varRef(implLocal.id, fn!, loc),
        original(),
        [unmock],
        timesOption.times,
        loc,
      ),
      loc,
    },
    trackMock(lowerer, tracker, ctxType!, ctx(), loc),
  );
  // The object's field: the wrapper that records the object as `this`.
  const fieldWrapperLocal = lowerer.declareHiddenLocal("%mockFieldWrapper", fn!);
  stmts.push({
    kind: "varDecl",
    localId: fieldWrapperLocal.id,
    init: {
      kind: "call",
      callee: mockWrapperFactory(lowerer, ctxType!, loc),
      args: [ctx()],
      type: fn!,
      loc,
    },
    loc,
  });
  const fieldWrapper = varRef(fieldWrapperLocal.id, fn!, loc);
  stmts.push(
    dynamicObject
      ? {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "dyn.keySet",
            args: [obj(), key(), lowerer.coerceToExpected(fieldWrapper, DYN)],
            type: VOID,
            loc,
          },
          loc,
        }
      : recordSet(obj(), field, fieldWrapper, loc),
  );
  defineMockProps(lowerer, stmts, call, fieldWrapper, ctx(), loc);
  // The returned mock: a wrapper that records `this` as undefined, the way
  // Node's bare call of the returned function does (the field's wrapper
  // records the object). Both carry the same context as `mock`.
  const wrapperLocal = lowerer.declareHiddenLocal("%mockWrapper", fn!);
  stmts.push({
    kind: "varDecl",
    localId: wrapperLocal.id,
    init: {
      kind: "call",
      callee: mockWrapperFactory(lowerer, ctxType!, loc),
      args: [ctx()],
      type: fn!,
      loc,
    },
    loc,
  });
  const wrapper = varRef(wrapperLocal.id, fn!, loc);
  defineMockProps(lowerer, stmts, call, wrapper, ctx(), loc);
  return { kind: "seqExpr", stmts, result: wrapper, type: fn!, loc };
}

/** The function type a property accessor mock has: the getter takes no
 * arguments and answers the property's type, the setter takes it and
 * answers nothing. Null when the object's static type does not declare the
 * property or its type has no lowering. */
function mockAccessorFnType(
  lowerer: Lowerer,
  objectNode: ts.Expression,
  field: string,
  kind: "get" | "set",
): FuncType | null {
  const objectType = lowerer.checker.getNonNullableType(lowerer.typeOf(objectNode));
  const property = lowerer.checker.getPropertyOfType(objectType, field);
  if (property === undefined) return null;
  const propertyTs = lowerer.checker.getTypeOfSymbolAtLocation(property, objectNode);
  const propertyType = lowerer.mapTypeOf(propertyTs);
  if (propertyType === null) return null;
  return kind === "get"
    ? { kind: "func", params: [], ret: propertyType }
    : { kind: "func", params: [propertyType], ret: VOID };
}

/** `%mock.unmock.accessor.N(object, key, descriptor)`: the closure that
 * puts the original property descriptor back, which restores the accessor
 * the mock replaced. */
function mockAccessorUnmockFactory(lowerer: Lowerer, ctxType: IrType, loc: SrcLoc): string {
  return liftOnce(lowerer, ctxType, "unmockAccessor", (name) => {
    const impl = `${name}.impl`;
    const captures = [
      { localId: "obj.0", name: "object", type: DYN },
      { localId: "key.0", name: "key", type: DYN },
      { localId: "desc.0", name: "descriptor", type: DYN },
    ];
    const boxedLocals = captures.map((c) => boxedLocal(c.localId, c.name, c.type));
    lowerer.liftedFns.push({
      name: impl,
      params: [],
      returnType: VOID,
      captures,
      locals: [...boxedLocals, { id: "out.0", name: "restored", type: DYN, mutable: false }],
      body: [
        {
          kind: "varDecl",
          localId: "out.0",
          init: {
            kind: "libCall",
            fn: "dyn.defineProperty",
            args: [
              varRef("obj.0", DYN, loc),
              varRef("key.0", DYN, loc),
              varRef("desc.0", DYN, loc),
            ],
            type: DYN,
            loc,
          },
          loc,
        },
        { kind: "return", value: null, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: captures,
      returnType: RESTORE_FN,
      locals: boxedLocals,
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: impl,
            captures: ["obj.0", "key.0", "desc.0"],
            type: RESTORE_FN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  });
}

/** mock.getter/mock.setter on a typed object literal: the record stores the
 * accessor in a %get:name / %set:name slot of a function type, and every
 * read or write of the property calls that slot, so replacing it with the
 * mock (and restore() writing the original back) intercepts the property. */
function lowerMockAccessorRecord(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
  tracker: MockTracker,
  objectValue: IrExpr,
  objectNode: ts.Expression,
  field: string,
  implArg: MockImplementationArg,
  timesOption: { times: IrExpr; check: IrStmt[] },
  kind: "get" | "set",
): IrExpr {
  const implementation = implArg && "lowered" in implArg ? implArg : null;
  const loc = locOf(call);
  const record = objectValue.type as IrType & { kind: "record" };
  const slotName = kind === "get" ? `%get:${field}` : `%set:${field}`;
  const shape = lowerer.shapes.get(record.shapeId);
  const slot = shape?.fields.find((f) => f.name === slotName);
  if (!slot || slot.type.kind !== "func") {
    lowerer.noLowering(
      `${what} of '${field}'`,
      objectNode,
      "the object's type declares no such accessor; Node throws ERR_INVALID_ARG_VALUE (\"The argument 'methodName' must be a method. Received undefined\") when the property is not an accessor",
    );
  }
  const fn = slot.type;
  const ctxType = mockContextType(fn, lowerer.typeCtx);
  if (!ctxType || !isMockContextType(lowerer, ctxType)) {
    lowerer.noLowering(
      `${what} of a '${lowerer.fmt(fn)}' accessor`,
      call,
      "mock accessors lower for properties whose type has a function form with fixed parameters",
    );
  }
  const fields = mockContextFields(lowerer, ctxType!)!;
  if (kind === "get") requireUndefinedResultArm(lowerer, fields, call, what);
  const stmts: IrStmt[] = [];
  const objLocal = lowerer.declareHiddenLocal("%mockObject", record);
  const obj = () => varRef(objLocal.id, record, loc);
  stmts.push({ kind: "varDecl", localId: objLocal.id, init: objectValue, loc });
  /* The call's arguments evaluate before the mock reads the current slot:
   * the implementation (or an undefined-answering expression, for its
   * effects) and the { times } option run first, so a slot they replace is
   * the one the mock captures and restores. */
  const originalLocal = lowerer.declareHiddenLocal("%mockOriginal", fn);
  const implLocal = lowerer.declareHiddenLocal("%mockImplementation", fn);
  if (implArg && "unit" in implArg) stmts.push({ kind: "exprStmt", expr: implArg.unit, loc });
  if (implementation !== null)
    stmts.push({
      kind: "varDecl",
      localId: implLocal.id,
      init: lowerer.coerceToExpected(implementation.lowered, fn),
      loc,
    });
  stmts.push(...timesOption.check);
  stmts.push({
    kind: "varDecl",
    localId: originalLocal.id,
    init: recordGet(obj(), slotName, fn, loc),
    loc,
  });
  if (implementation === null) {
    /* No implementation: the mock wraps the original accessor, the function
     * the slot holds (reading the slot does not invoke it). */
    stmts.push({
      kind: "varDecl",
      localId: implLocal.id,
      init: varRef(originalLocal.id, fn, loc),
      loc,
    });
  }
  const unmock: IrExpr = {
    kind: "call",
    callee: mockUnmockFactory(lowerer, ctxType!, record, slotName, loc),
    args: [obj(), varRef(originalLocal.id, fn, loc)],
    type: RESTORE_FN,
    loc,
  };
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  const ctx = () => varRef(ctxLocal.id, ctxType!, loc);
  stmts.push(
    {
      kind: "varDecl",
      localId: ctxLocal.id,
      init: mockContextLiteral(
        ctxType!,
        fields,
        varRef(implLocal.id, fn, loc),
        varRef(originalLocal.id, fn, loc),
        [unmock],
        timesOption.times,
        loc,
      ),
      loc,
    },
    trackMock(lowerer, tracker, ctxType!, ctx(), loc),
  );
  const wrapperLocal = lowerer.declareHiddenLocal("%mockWrapper", fn);
  stmts.push({
    kind: "varDecl",
    localId: wrapperLocal.id,
    init: {
      kind: "call",
      callee: mockWrapperFactory(lowerer, ctxType!, loc),
      args: [ctx()],
      type: fn,
      loc,
    },
    loc,
  });
  stmts.push(recordSet(obj(), slotName, varRef(wrapperLocal.id, fn, loc), loc));
  defineMockProps(lowerer, stmts, call, varRef(wrapperLocal.id, fn, loc), ctx(), loc);
  return { kind: "seqExpr", stmts, result: varRef(wrapperLocal.id, fn, loc), type: fn, loc };
}

/** mock.getter/mock.setter (and mock.method with { getter }/{ setter }) on
 * an object held as a checked-dynamic value: Node redefines the property
 * with the mock as its accessor, keeping the original descriptor for
 * restore(). The object's accessors live in the checked-dynamic property
 * machinery here (an object literal with accessors is that object), so the
 * descriptor rewrite intercepts every read and write of the property. */
function lowerMockAccessorCore(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
  tracker: MockTracker,
  objectNode: ts.Expression,
  field: string,
  implArg: MockImplementationArg,
  timesOption: { times: IrExpr; check: IrStmt[] },
  kind: "get" | "set",
): IrExpr {
  const implementation = implArg && "lowered" in implArg ? implArg : null;
  const loc = locOf(call);
  const objectValue = lowerer.lowerExpr(objectNode);
  if (objectValue.type.kind === "record") {
    /* A typed object literal inside a function is a record with accessor
     * slots (%get:name / %set:name); the mock replaces the slot, which every
     * read and write of the property calls. */
    return lowerMockAccessorRecord(
      lowerer,
      call,
      what,
      tracker,
      objectValue,
      objectNode,
      field,
      implArg,
      timesOption,
      kind,
    );
  }
  if (objectValue.type.kind !== "dyn" && objectValue.type.kind !== "jsval") {
    lowerer.noLowering(
      `${what} on this object`,
      objectNode,
      "a property accessor mock lowers for an object held as a checked-dynamic value (an object literal with accessors, or an untyped object); a static record's or a class instance's property cannot be intercepted",
    );
  }
  /* The accessor's function type comes from the object's declaration; an
   * untyped object (a JavaScript value) has none, so the implementation's
   * own type stands for it — Node calls that function for the property
   * either way. */
  let fn = mockAccessorFnType(lowerer, objectNode, field, kind);
  if (fn === null) {
    if (implementation === null) {
      lowerer.noLowering(
        `${what} without an implementation on an untyped object`,
        call,
        "pass the getter or setter function as the third argument: without it the accessor's signature is unknown on an object with no declared type",
      );
    }
    if (implementation.lowered.type.kind !== "func") {
      lowerer.noLowering(
        `${what} with this implementation`,
        implementation.node,
        "pass the accessor's function as the implementation",
      );
    }
    fn = implementation.lowered.type;
  }
  const ctxType = mockContextType(fn!, lowerer.typeCtx);
  if (!ctxType || !isMockContextType(lowerer, ctxType)) {
    lowerer.noLowering(
      `${what} of a '${lowerer.fmt(fn!)}' accessor`,
      call,
      "mock accessors lower for properties whose type has a function form with fixed parameters",
    );
  }
  const fields = mockContextFields(lowerer, ctxType!)!;
  if (kind === "get") requireUndefinedResultArm(lowerer, fields, call, what);
  const stmts: IrStmt[] = [];
  const objLocal = lowerer.declareHiddenLocal("%mockObject", DYN);
  const obj = () => varRef(objLocal.id, DYN, loc);
  stmts.push({
    kind: "varDecl",
    localId: objLocal.id,
    init:
      objectValue.type.kind === "dyn" ? objectValue : lowerer.coerceToExpected(objectValue, DYN),
    loc,
  });
  const keyLocal = lowerer.declareHiddenLocal("%mockKey", DYN);
  const key = () => varRef(keyLocal.id, DYN, loc);
  stmts.push({
    kind: "varDecl",
    localId: keyLocal.id,
    init: lowerer.coerceToExpected(strLit(field, loc), DYN),
    loc,
  });
  /* The call's arguments evaluate before Node's method() runs: the
   * implementation (and the options' times check) come before the accessor
   * lookup, so their side effects are never skipped by a rejection and the
   * descriptor read is not stale. */
  const implLocal = lowerer.declareHiddenLocal("%mockImplementation", fn!);
  /* The original descriptor the restore() closure redefines, and a second
   * copy the mock rewrites and installs (Node keeps the original intact). */
  const originalDesc = lowerer.declareHiddenLocal("%mockOriginalDescriptor", DYN);
  const mockDesc = lowerer.declareHiddenLocal("%mockDescriptor", DYN);
  const descriptorDecls = (): IrStmt[] =>
    [originalDesc, mockDesc].map((slot) => ({
      kind: "varDecl" as const,
      localId: slot.id,
      init: {
        kind: "libCall" as const,
        fn: "test.accessorDescriptor",
        args: [obj(), key()],
        type: DYN,
        loc,
      },
      loc,
    }));
  if (implArg && "unit" in implArg) stmts.push({ kind: "exprStmt", expr: implArg.unit, loc });
  if (implementation !== null)
    stmts.push({
      kind: "varDecl",
      localId: implLocal.id,
      init: lowerer.coerceToExpected(implementation.lowered, fn!),
      loc,
    });
  stmts.push(...timesOption.check);
  stmts.push(...descriptorDecls());
  if (implementation === null) {
    /* No implementation: the mock wraps the accessor the descriptor holds;
     * the wrapper calls it with the object as its receiver. The descriptor
     * member arrives as a checked-dynamic value, so it converts into the
     * accessor's function type like any other implementation. */
    const original: IrExpr = {
      kind: "dynKeyGet",
      key: strLit(kind === "get" ? "get" : "set", loc),
      value: varRef(originalDesc.id, DYN, loc),
      type: DYN,
      loc,
    };
    stmts.push({
      kind: "varDecl",
      localId: implLocal.id,
      init: lowerer.coerceToExpected(original, fn!),
      loc,
    });
  }
  /* Node finds the accessor on the prototype chain and requires it to be a
   * function: a data property, or the opposite half of an accessor pair,
   * throws ERR_INVALID_ARG_VALUE before the mock exists. */
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "test.accessorRequire",
      args: [varRef(originalDesc.id, DYN, loc), boolLit(kind === "set", loc)],
      type: VOID,
      loc,
    },
    loc,
  });
  const unmock: IrExpr = {
    kind: "call",
    callee: mockAccessorUnmockFactory(lowerer, ctxType!, loc),
    args: [obj(), key(), varRef(originalDesc.id, DYN, loc)],
    type: RESTORE_FN,
    loc,
  };
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  const ctx = () => varRef(ctxLocal.id, ctxType!, loc);
  stmts.push(
    {
      kind: "varDecl",
      localId: ctxLocal.id,
      init: mockContextLiteral(
        ctxType!,
        fields,
        varRef(implLocal.id, fn!, loc),
        varRef(implLocal.id, fn!, loc),
        [unmock],
        timesOption.times,
        loc,
      ),
      loc,
    },
    trackMock(lowerer, tracker, ctxType!, ctx(), loc),
  );
  const wrapperLocal = lowerer.declareHiddenLocal("%mockWrapper", fn!);
  stmts.push({
    kind: "varDecl",
    localId: wrapperLocal.id,
    init: {
      kind: "call",
      callee: mockWrapperFactory(lowerer, ctxType!, loc),
      args: [ctx()],
      type: fn!,
      loc,
    },
    loc,
  });
  const wrapper = () => varRef(wrapperLocal.id, fn!, loc);
  const boxedLocal = lowerer.declareHiddenLocal("%mockAccessor", DYN);
  stmts.push({
    kind: "varDecl",
    localId: boxedLocal.id,
    init: lowerer.coerceToExpected(wrapper(), DYN),
    loc,
  });
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [
        varRef(mockDesc.id, DYN, loc),
        strLit(kind === "get" ? "get" : "set", loc),
        varRef(boxedLocal.id, DYN, loc),
      ],
      type: VOID,
      loc,
    },
    loc,
  });
  const installed = lowerer.declareHiddenLocal("%mockInstalled", DYN);
  stmts.push({
    kind: "varDecl",
    localId: installed.id,
    init: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [obj(), key(), varRef(mockDesc.id, DYN, loc)],
      type: DYN,
      loc,
    },
    loc,
  });
  defineMockProps(lowerer, stmts, call, wrapper(), ctx(), loc);
  return { kind: "seqExpr", stmts, result: wrapper(), type: fn!, loc };
}

/** The implementation argument, lowered once. Null when the argument is
 * absent AND when it lowers to a unit value (`undefined`, `void 0`):
 * Node treats both as "wrap the original method or accessor". Lowering it
 * here keeps the evaluation point where the call's arguments evaluate and
 * lets the callee receive the already-lowered expression, so nothing is
 * lowered twice. */
type MockImplementationArg = { node: ts.Expression; lowered: IrExpr } | { unit: IrExpr } | null;

function lowerMockImplementationArg(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
): MockImplementationArg {
  if (node === undefined) return null;
  const lowered = lowerer.lowerExpr(node);
  if (lowered.kind === "unitLit") return null;
  /* An expression that answers undefined selects the original, but its own
   * effects still run where the call's arguments evaluate. */
  if (lowered.type.kind === "void" || lowered.type.kind === "undefinedT") return { unit: lowered };
  return { node, lowered };
}

/** mock.getter(object, name, implementation[, options]) and its setter
 * twin. The implementation is required: calling the original accessor
 * through the mock is not lowered. */
export function lowerMockAccessor(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
  tracker: MockTracker,
  kind: "get" | "set",
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (args.length < 2 || args.length > 4 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      call,
      "the supported forms are mock.getter(object, methodName, implementation) and the same with a trailing { times } options object",
    );
  }
  const nameArg = args[1]!;
  if (!ts.isStringLiteralLike(nameArg)) {
    lowerer.noLowering(
      `${what} with a computed property name`,
      nameArg,
      "pass the property name as a string literal",
    );
  }
  const field = (nameArg as ts.StringLiteralLike).text;
  const isOptions = (arg: ts.Expression | undefined): boolean =>
    arg !== undefined &&
    ts.isObjectLiteralExpression(arg) &&
    lowerer.checker.getCallSignatures(lowerer.typeOf(arg)).length === 0;
  const trailing = args[2];
  const implementationNode = trailing === undefined || isOptions(trailing) ? undefined : trailing;
  const implArg = lowerMockImplementationArg(lowerer, implementationNode);
  const optionsNode = args.length === 4 ? args[3] : isOptions(trailing) ? trailing : undefined;
  if (args.length === 4 && trailing !== undefined && isOptions(trailing)) {
    lowerer.noLowering(
      `${what} with an options object before its implementation`,
      trailing,
      "pass the implementation, then the { times } options object",
    );
  }
  const timesOption = mockTimesOption(lowerer, optionsNode, what, loc);
  return lowerMockAccessorCore(
    lowerer,
    call,
    what,
    tracker,
    args[0]!,
    field,
    implArg,
    timesOption,
    kind,
  );
}

/** The trackers' restoreAll() and reset(): `mock.restoreAll()`,
 * `t.mock.reset()`. */
export function lowerMockTrackerCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: "restoreAll" | "reset",
  tracker: MockTracker,
): IrExpr {
  if (call.arguments.nodes.length > 0) {
    lowerer.noLowering(`MockTracker.${member} with ${call.arguments.nodes.length} arguments`, call);
  }
  const fn = tracker
    ? member === "reset"
      ? "test.ctxMockReset"
      : "test.ctxMockRestoreAll"
    : member === "reset"
      ? "test.mockReset"
      : "test.mockRestoreAll";
  return {
    kind: "libCall",
    fn,
    args: tracker ? [tracker] : [],
    type: VOID,
    loc: locOf(call),
  };
}

const MOCK_TIMERS_HINT =
  "enable, tick, runAll, reset and setTime are the supported mock.timers members";
const MOCK_TIMERS_APIS_HINT =
  "list the mocked APIs as string literals: enable({ apis: ['setTimeout', 'Date'] })";
/** The codes scr_test.c reads for the APIs enable() mocks, in Node's
 * SUPPORTED_APIS order. */
const MOCK_TIMERS_API_CODES: Readonly<Record<string, string>> = {
  setTimeout: "T",
  setInterval: "I",
  setImmediate: "M",
  Date: "D",
  "scheduler.wait": "W",
  "AbortSignal.timeout": "A",
};
/** enable() and enable({ now }) without `apis` mock every API. */
const MOCK_TIMERS_ALL_APIS = "TIMDWA";

/** `mock.timers.enable(...)` and the other MockTimers members, on the
 * module's `mock` (tracker null) and t.mock. enable() takes no options or
 * an object literal whose `apis`, when given, is an array literal of API
 * names. */
export function lowerMockTimersCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  member: string,
  what: string,
  tracker: () => MockTracker,
  sym: ts.Symbol | null,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const optionalNumber = (fallback: number): IrExpr[] => {
    if (args.length > 1)
      lowerer.noLowering(`${what}.${member} with ${args.length} arguments`, call);
    return [args.length === 1 ? lowerer.lowerExprExpecting(args[0]!, F64) : numLit(fallback, loc)];
  };
  if (!["enable", "tick", "setTime", "runAll", "reset"].includes(member)) {
    lowerer.noLowering(`${what}.${member}`, call, MOCK_TIMERS_HINT, sym);
  }
  // The receiver evaluates before the arguments.
  const t = tracker();
  let rest: IrExpr[];
  switch (member) {
    case "enable":
      rest = lowerMockTimersOptions(lowerer, call, what);
      break;
    case "tick":
      rest = optionalNumber(1);
      break;
    case "setTime":
      rest = optionalNumber(0);
      break;
    default:
      if (args.length > 0) {
        lowerer.noLowering(`${what}.${member} with ${args.length} arguments`, call);
      }
      rest = [];
  }
  const name = member[0]!.toUpperCase() + member.slice(1);
  return {
    kind: "libCall",
    fn: (t ? `test.ctxMockTimers${name}` : `test.mockTimers${name}`) as IrLibFn,
    args: t ? [t, ...rest] : rest,
    type: VOID,
    loc,
  };
}

/** enable()'s { apis, now } as the libCall's API codes, `now` and flags
 * (1 = `now` given, 2 = it is a Date). */
function lowerMockTimersOptions(lowerer: Lowerer, call: ts.CallExpression, what: string): IrExpr[] {
  const loc = locOf(call);
  const options = call.arguments.nodes[0];
  if (call.arguments.nodes.length > 1) {
    lowerer.noLowering(`${what}.enable with ${call.arguments.nodes.length} arguments`, call);
  }
  if (options === undefined) {
    return [strLit(MOCK_TIMERS_ALL_APIS, loc), numLit(0, loc), numLit(0, loc)];
  }
  if (!ts.isObjectLiteralExpression(options)) {
    lowerer.noLowering(
      `${what}.enable with a non-literal options object`,
      options,
      MOCK_TIMERS_APIS_HINT,
    );
  }
  let codes = "";
  let listed = false;
  let now: IrExpr = numLit(0, loc);
  let flags = 0;
  for (const prop of options.properties.nodes) {
    // `{ apis: [...] }`, `{ "now": n }` and the `{ now }` shorthand.
    const init = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)
        ? prop.name
        : null;
    const key =
      init && prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ? prop.name.text
        : null;
    if (key === "apis") {
      const list = init!;
      if (!ts.isArrayLiteralExpression(list)) {
        lowerer.noLowering(
          `${what}.enable with a non-literal apis list`,
          list,
          MOCK_TIMERS_APIS_HINT,
        );
      }
      listed = true;
      for (const el of list.elements.nodes) {
        if (!ts.isStringLiteralLike(el)) {
          lowerer.noLowering(
            `${what}.enable with a non-literal API name`,
            el,
            MOCK_TIMERS_APIS_HINT,
          );
        }
        const code = MOCK_TIMERS_API_CODES[el.text] ?? "";
        if (code === "") {
          lowerer.noLowering(`${what}.enable with the ${el.text} API`, el, MOCK_TIMERS_APIS_HINT);
        }
        codes += code;
      }
    } else if (key === "now") {
      const value = lowerer.lowerExpr(init!);
      if (value.type.kind === "date") {
        now = { kind: "libCall", fn: "date.getTime", args: [value], type: F64, loc };
        flags = 3;
      } else if (value.type.kind === "f64") {
        now = value;
        flags = 1;
      } else {
        lowerer.noLowering(
          `${what}.enable with a now value of this type`,
          prop,
          "now takes a number or a Date",
        );
      }
    } else {
      lowerer.noLowering(
        `${what}.enable with this option`,
        prop,
        "apis and now are the supported enable options",
      );
    }
  }
  return [strLit(listed ? codes : MOCK_TIMERS_ALL_APIS, loc), now, numLit(flags, loc)];
}

/** `fn.mock.calls`: a copy of the log, as Node's getter returns. Null for
 * other reads. */
export function lowerMockContextProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken || expr.name.text !== "calls") return null;
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (!receiverType || !isMockContextType(lowerer, receiverType)) return null;
  const { calls } = mockContextFields(lowerer, receiverType)!;
  const loc = locOf(expr);
  return {
    kind: "arrIntrinsic",
    method: "slice",
    receiver: recordGet(lowerer.lowerExpr(expr.expression), "calls", calls, loc),
    args: [],
    type: calls,
    loc,
  };
}

/** The fn.mock context's methods. Null for other receivers. */
export function lowerMockContextCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const ctxType = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (!ctxType || !isMockContextType(lowerer, ctxType)) return null;
  const { fn, calls, once, onceEntry } = mockContextFields(lowerer, ctxType)!;
  const loc = locOf(call);
  const member = access.name.text;
  const args = call.arguments.nodes;
  const arity = (min: number, max: number = min) => {
    if (args.length < min || args.length > max || args.some(ts.isSpreadElement))
      lowerer.noLowering(`MockFunctionContext.${member} with ${args.length} arguments`, call);
  };
  const helperCall = (helper: string, extra: IrExpr[]): IrExpr => ({
    kind: "call",
    callee: helper,
    args: [lowerer.lowerExpr(access.expression), ...extra],
    type: VOID,
    loc,
  });
  switch (member) {
    case "callCount":
      arity(0);
      return length(recordGet(lowerer.lowerExpr(access.expression), "calls", calls, loc), loc);
    case "mockImplementation": {
      arity(1);
      const helper = mockHelper(
        lowerer,
        ctxType,
        "setImplementation",
        [{ id: "f.0", name: "implementation", type: fn }],
        (ctx) => [recordSet(ctx(), "%impl", varRef("f.0", fn, loc), loc)],
        loc,
      );
      return helperCall(helper, [lowerer.lowerExprExpecting(args[0]!, fn)]);
    }
    case "mockImplementationOnce": {
      arity(1, 2);
      // onCall defaults to the next call: the log's length (NaN marks the
      // default). A later registration for the same index replaces it, as
      // Node's Map does.
      const helper = mockHelper(
        lowerer,
        ctxType,
        "setImplementationOnce",
        [
          { id: "f.0", name: "implementation", type: fn },
          { id: "at.0", name: "onCall", type: F64 },
        ],
        (ctx) => {
          const at = () => varRef("at.0", F64, loc);
          const onceArray = () => recordGet(ctx(), "%once", once, loc);
          return [
            {
              kind: "if",
              cond: { kind: "bin", op: "!==", left: at(), right: at(), type: BOOL, loc },
              then: [
                {
                  kind: "assign",
                  localId: "at.0",
                  value: length(recordGet(ctx(), "calls", calls, loc), loc),
                  loc,
                },
              ],
              else_: null,
              loc,
            },
            countedFor(loc, length(onceArray(), loc), (j) => [
              {
                kind: "if",
                cond: {
                  kind: "bin",
                  op: "===",
                  left: recordGet(
                    { kind: "arrayGet", arr: onceArray(), index: j, type: onceEntry, loc },
                    "at",
                    F64,
                    loc,
                  ),
                  right: at(),
                  type: BOOL,
                  loc,
                },
                then: [
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "arrIntrinsic",
                      method: "splice",
                      receiver: onceArray(),
                      args: [j, numLit(1, loc)],
                      type: once,
                      loc,
                    },
                    loc,
                  },
                ],
                else_: null,
                loc,
              },
            ]),
            {
              kind: "exprStmt",
              expr: {
                kind: "arrIntrinsic",
                method: "push",
                receiver: onceArray(),
                args: [
                  {
                    kind: "recordLit",
                    fields: [
                      { name: "at", value: at() },
                      { name: "fn", value: varRef("f.0", fn, loc) },
                    ],
                    type: onceEntry,
                    loc,
                  },
                ],
                type: F64,
                loc,
              },
              loc,
            },
          ];
        },
        loc,
      );
      return helperCall(helper, [
        lowerer.lowerExprExpecting(args[0]!, fn),
        args.length === 2 ? lowerer.lowerExprExpecting(args[1]!, F64) : numLit(NaN, loc),
      ]);
    }
    case "resetCalls": {
      arity(0);
      const helper = mockHelper(
        lowerer,
        ctxType,
        "resetCalls",
        [],
        (ctx) => [
          recordSet(ctx(), "calls", { kind: "arrayLit", elems: [], type: calls, loc }, loc),
        ],
        loc,
      );
      return helperCall(helper, []);
    }
    case "restore":
      arity(0);
      return helperCall(mockRestoreHelper(lowerer, ctxType, loc), []);
    default:
      return lowerer.noLowering(
        `MockFunctionContext.${member}`,
        call,
        "calls, callCount, mockImplementation, mockImplementationOnce, resetCalls and restore are the supported mock context members",
      );
  }
}
