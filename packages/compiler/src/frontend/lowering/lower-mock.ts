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
import { countedFor, dynUndefinedExpr, numLit, strLit, varRef } from "../../ir/build.js";
import type { IrLibFn } from "../../ir/builtin-signatures.js";
import { mockType as mockHybridType } from "../mock-shapes.js";
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
  if (
    impl?.kind !== "func" ||
    once?.kind !== "array" ||
    calls?.kind !== "array" ||
    unmock?.kind !== "array" ||
    field("%original") === undefined
  )
    return null;
  const call = calls.elem;
  const callShape = call.kind === "record" ? lowerer.shapes.get(call.shapeId) : undefined;
  const result = callShape?.fields.find((f) => f.name === "result")?.type;
  const args = callShape?.fields.find((f) => f.name === "arguments")?.type;
  if (!result || !args) return null;
  return { fn: impl, call, calls, once, onceEntry: once.elem, unmock, result, args };
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

/** `%mock.wrap.N(ctx)`: the closure that records each call into ctx, with
 * `this` undefined. `%mock.wrapMethod.N(ctx, this)` records `this`. */
function mockWrapperFactory(
  lowerer: Lowerer,
  ctxType: IrType,
  loc: SrcLoc,
  withThis = false,
): string {
  return liftOnce(lowerer, ctxType, withThis ? "wrapMethod" : "wrap", (name) => {
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
                value: withThis ? varRef("this.0", DYN, loc) : dynUndefinedExpr(loc),
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
    const invoke: IrExpr = dynRest
      ? {
          kind: "dynCall",
          callee: { kind: "dynFrom", value: varRef("f.0", fn, loc), type: DYN, loc },
          calleeName: "implementation",
          args: paramRefs(),
          spreads: [{ arg: 0, what: "args" }],
          type: DYN,
          loc,
        }
      : {
          kind: "callValue",
          callee: varRef("f.0", fn, loc),
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
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: fn.ret,
      captures: [
        { localId: "ctx.0", name: "ctx", type: ctxType },
        ...(withThis ? [{ localId: "this.0", name: "this", type: DYN }] : []),
      ],
      locals: [
        ...params.map((p) => local(p.localId, p.name, p.type)),
        boxedLocal("ctx.0", "ctx", ctxType),
        ...(withThis ? [boxedLocal("this.0", "this", DYN)] : []),
        local("n.0", "index", F64),
        local("f.0", "implementation", fn, true),
        local("i.0", "entry", F64, true),
        ...(voidReturn ? [] : [local("r.0", "result", fn.ret)]),
        local("e.0", "error", CAUGHT),
      ],
      body: [
        {
          kind: "varDecl",
          localId: "n.0",
          init: length(recordGet(ctx(), "calls", calls, loc), loc),
          loc,
        },
        { kind: "varDecl", localId: "f.0", init: recordGet(ctx(), "%impl", fn, loc), loc },
        pickOnce,
        { kind: "tryCatch", tryBody, catchBody, catchLocalId: "e.0", finallyBody: null, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "ctx.0", name: "ctx", type: ctxType },
        ...(withThis ? [{ localId: "this.0", name: "this", type: DYN }] : []),
      ],
      returnType: fn,
      locals: [
        boxedLocal("ctx.0", "ctx", ctxType),
        ...(withThis ? [boxedLocal("this.0", "this", DYN)] : []),
      ],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: impl,
            captures: withThis ? ["ctx.0", "this.0"] : ["ctx.0"],
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
function mockRestoreHelper(lowerer: Lowerer, ctxType: IrType, loc: SrcLoc): string {
  const { fn, unmock } = mockContextFields(lowerer, ctxType)!;
  return mockHelper(
    lowerer,
    ctxType,
    "restore",
    [],
    (ctx) => {
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
      ];
    },
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
  loc: SrcLoc,
): IrExpr {
  return {
    kind: "recordLit",
    fields: [
      { name: "%impl", value: implementation },
      { name: "%once", value: { kind: "arrayLit", elems: [], type: fields.once, loc } },
      { name: "%original", value: original },
      { name: "%unmock", value: { kind: "arrayLit", elems: unmock, type: fields.unmock, loc } },
      { name: "calls", value: { kind: "arrayLit", elems: [], type: fields.calls, loc } },
    ],
    type: ctxType,
    loc,
  };
}

/** The Mock<F> record over a context: { %call: wrapper, mock: context }. */
function mockRecord(
  lowerer: Lowerer,
  mockType: IrType,
  ctxType: IrType,
  ctx: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const { fn } = mockContextFields(lowerer, ctxType)!;
  return {
    kind: "recordLit",
    fields: [
      {
        name: "%call",
        value: {
          kind: "call",
          callee: mockWrapperFactory(lowerer, ctxType, loc),
          args: [ctx],
          type: fn,
          loc,
        },
      },
      { name: "mock", value: ctx },
    ],
    type: mockType,
    loc,
  };
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
export function lowerMockFn(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
  tracker: MockTracker,
): IrExpr {
  const loc = locOf(call);
  const mockType = lowerer.mapTypeOf(lowerer.typeOf(call));
  const shape = mockType?.kind === "record" ? lowerer.shapes.get(mockType.shapeId) : undefined;
  const ctxType = shape?.fields.find((f) => f.name === "mock")?.type;
  if (
    !mockType ||
    !shape ||
    shape.fields.length !== 2 ||
    !shape.fields.some((f) => f.name === "%call") ||
    !ctxType ||
    !isMockContextType(lowerer, ctxType)
  ) {
    lowerer.noLowering(
      `${what} of this function type`,
      call,
      "mock functions lower for functions with fixed parameters, or a single rest array parameter, and an implementation of the same type",
    );
  }
  const fields = mockContextFields(lowerer, ctxType!)!;
  const { fn } = fields;
  requireUndefinedResultArm(lowerer, fields, call, what);
  const args = call.arguments.nodes;
  if (args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      call,
      "the supported forms are mock.fn(), mock.fn(original) and mock.fn(original, implementation); mock options have no lowering",
    );
  }
  const noop = args.length === 0 ? mockNoopOriginal(lowerer, ctxType!, fn, loc) : null;
  if (args.length === 0 && !noop) {
    lowerer.noLowering(
      `${what}() of a function returning '${lowerer.fmt(fn.ret)}'`,
      call,
      "mock.fn() without an original returns undefined: pass an original, or use a function type whose return type includes undefined",
    );
  }
  const stmts: IrStmt[] = [];
  const originalLocal = lowerer.declareHiddenLocal("%mockOriginal", fn);
  stmts.push({
    kind: "varDecl",
    localId: originalLocal.id,
    init: noop ?? lowerer.lowerExprExpecting(args[0]!, fn),
    loc,
  });
  const implementation =
    args.length === 2
      ? lowerer.lowerExprExpecting(args[1]!, fn)
      : varRef(originalLocal.id, fn, loc);
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  const ctx = () => varRef(ctxLocal.id, ctxType!, loc);
  stmts.push(
    {
      kind: "varDecl",
      localId: ctxLocal.id,
      init: mockContextLiteral(
        ctxType!,
        fields,
        implementation,
        varRef(originalLocal.id, fn, loc),
        [],
        loc,
      ),
      loc,
    },
    trackMock(lowerer, tracker, ctxType!, ctx(), loc),
  );
  return {
    kind: "seqExpr",
    stmts,
    result: mockRecord(lowerer, mockType!, ctxType!, ctx(), loc),
    type: mockType!,
    loc,
  };
}

const METHOD_HINT =
  "mock.method lowers for objects whose type maps to a record (object literals and interface-typed objects) and a function-valued field named by a string literal";

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
  if (args.length < 2 || args.length > 3 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      call,
      "the supported forms are mock.method(object, methodName) and mock.method(object, methodName, implementation); mock options have no lowering",
    );
  }
  const nameArg = args[1]!;
  if (!ts.isStringLiteralLike(nameArg)) {
    lowerer.noLowering(`${what} with a computed method name`, nameArg, METHOD_HINT);
  }
  const field = (nameArg as ts.StringLiteralLike).text;
  if (
    args.length === 3 &&
    lowerer.checker.getCallSignatures(lowerer.typeOf(args[2]!)).length === 0
  ) {
    lowerer.noLowering(
      `${what} with an options object`,
      args[2]!,
      "mock options (times, getter and setter) have no lowering",
    );
  }
  const objType = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
  const objShape = objType?.kind === "record" ? lowerer.shapes.get(objType.shapeId) : undefined;
  const fn = objShape?.fields.find((f) => f.name === field)?.type;
  if (!objType || !objShape || fn?.kind !== "func") {
    const typeName = ts.symbolNameOf(lowerer.typeOf(args[0]!).getSymbol());
    lowerer.noLowering(
      typeName && !typeName.startsWith("__")
        ? `${what} on '${typeName}'`
        : `${what} on this object`,
      args[0]!,
      METHOD_HINT,
    );
  }
  const mockType = mockHybridType(fn as FuncType, lowerer.typeCtx);
  const ctxType =
    mockType?.kind === "record"
      ? lowerer.shapes.get(mockType.shapeId)?.fields.find((f) => f.name === "mock")?.type
      : undefined;
  if (!mockType || !ctxType || !isMockContextType(lowerer, ctxType)) {
    lowerer.noLowering(
      `${what} of a '${lowerer.fmt(fn!)}' method`,
      call,
      "mock functions lower for functions with fixed parameters, or a single rest array parameter",
    );
  }
  if (!resultIsDiscarded(call)) {
    const resultType = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (!resultType || typeKey(resultType) !== typeKey(mockType!)) {
      lowerer.noLowering(
        `${what} with an implementation of another type`,
        args[2] ?? call,
        "give the implementation the method's parameter and return types, or discard the result",
      );
    }
  }
  const fields = mockContextFields(lowerer, ctxType!)!;
  requireUndefinedResultArm(lowerer, fields, call, what);
  const stmts: IrStmt[] = [];
  const objLocal = lowerer.declareHiddenLocal("%mockObject", objType!);
  const obj = () => varRef(objLocal.id, objType!, loc);
  stmts.push({ kind: "varDecl", localId: objLocal.id, init: lowerer.lowerExpr(args[0]!), loc });
  const originalLocal = lowerer.declareHiddenLocal("%mockOriginal", fn!);
  const original = () => varRef(originalLocal.id, fn!, loc);
  stmts.push({
    kind: "varDecl",
    localId: originalLocal.id,
    init: recordGet(obj(), field, fn!, loc),
    loc,
  });
  const implementation = args.length === 3 ? lowerer.lowerExprExpecting(args[2]!, fn!) : original();
  const unmock: IrExpr = {
    kind: "call",
    callee: mockUnmockFactory(
      lowerer,
      ctxType!,
      objType as IrType & { kind: "record" },
      field,
      loc,
    ),
    args: [obj(), original()],
    type: RESTORE_FN,
    loc,
  };
  const ctxLocal = lowerer.declareHiddenLocal("%mockContext", ctxType!);
  const ctx = () => varRef(ctxLocal.id, ctxType!, loc);
  stmts.push(
    {
      kind: "varDecl",
      localId: ctxLocal.id,
      init: mockContextLiteral(ctxType!, fields, implementation, original(), [unmock], loc),
      loc,
    },
    trackMock(lowerer, tracker, ctxType!, ctx(), loc),
    // The object's field: the wrapper that records the object as `this`.
    recordSet(
      obj(),
      field,
      {
        kind: "call",
        callee: mockWrapperFactory(lowerer, ctxType!, loc, true),
        args: [ctx(), lowerer.coerceToExpected(obj(), DYN)],
        type: fn!,
        loc,
      },
      loc,
    ),
  );
  return {
    kind: "seqExpr",
    stmts,
    result: mockRecord(lowerer, mockType!, ctxType!, ctx(), loc),
    type: mockType!,
    loc,
  };
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
