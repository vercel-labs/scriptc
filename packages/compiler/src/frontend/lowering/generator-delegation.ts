import { dynUndefinedExpr, numLit, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  STRING,
  VOID,
  canConvertToDyn,
  type IrExpr,
  type IrMapIntrinsicMethod,
  type IrSetIntrinsicMethod,
  type IrStmt,
  type IrType,
  typeEquals,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { arrayValueRead } from "./array-values.js";

const NO_THROW_METHOD = "The iterator does not provide a 'throw' method.";

/** The synchronous IteratorRecord protocol, including completion forwarding.
 * Native class methods enter through the checked-value dispatcher; every
 * step and every user method still executes as compiled code. */
export function lowerCheckedDelegation(
  lowerer: Lowerer,
  expr: ts.YieldExpression,
  source: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const gen = lowerer.ctx.generator!;
  const returnType = lowerer.ctx.returnType;
  for (const type of [gen.nextT, returnType]) {
    if (
      type.kind !== "void" &&
      type.kind !== "undefinedT" &&
      !canConvertToDyn(
        type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      lowerer.unsupported(
        "SC1071",
        expr,
        "delegation with a channel that cannot cross a checked iterator method",
      );
    }
  }
  const slot = (name: string, mutable = false) => {
    const local = lowerer.declareHiddenLocal(name, DYN);
    local.mutable = mutable;
    return { local, ref: varRef(local.id, DYN, loc) };
  };
  const iterator = slot("%delegate");
  const next = slot("%delegateNext");
  const step = slot("%delegateStep", true);
  const resume = slot("%delegateResume");
  const returned = slot("%delegateReturn");
  const thrown = slot("%delegateThrow");
  const close = slot("%delegateClose");
  const get = (value: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet",
    value,
    key: { kind: "strLit", value: key, type: STRING, loc },
    type: DYN,
    loc,
  });
  const check = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "dyn.iteratorResult",
    args: [value],
    type: DYN,
    loc,
  });
  const call = (callee: IrExpr, args: IrExpr[]): IrExpr =>
    check({
      kind: "dynCall",
      callee,
      receiver: iterator.ref,
      calleeName: "iterator method",
      args,
      type: DYN,
      loc,
    });
  const done = (): IrExpr => ({
    kind: "dynTest",
    test: "truthy",
    value: get(step.ref, "done"),
    type: BOOL,
    loc,
  });
  const absent = (value: IrExpr): IrExpr => ({
    kind: "dynTest",
    test: "nullish",
    value,
    type: BOOL,
    loc,
  });
  const sent = get(resume.ref, "value");
  const mode = (value: number): IrExpr => ({
    kind: "bin",
    op: "===",
    left: { kind: "dynCheck", value: get(resume.ref, "kind"), type: F64, loc },
    right: { kind: "numLit", value, type: F64, loc },
    type: BOOL,
    loc,
  });
  const assign = (value: IrExpr): IrStmt => ({
    kind: "assign",
    localId: step.local.id,
    value,
    loc,
  });
  const declare = (target: typeof next, init: IrExpr): IrStmt => ({
    kind: "varDecl",
    localId: target.local.id,
    init,
    loc,
  });
  const finish = (value: IrExpr): IrStmt[] =>
    returnType.kind === "void"
      ? [
          {
            kind: "if",
            cond: {
              kind: "unary",
              op: "!",
              operand: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
              type: BOOL,
              loc,
            },
            then: [
              {
                kind: "runtimeFence",
                code: "SC1071",
                message:
                  "returning a value through a void native generator channel is not supported yet",
                loc,
              },
            ],
            else_: null,
            loc,
          },
          { kind: "return", value: null, loc },
        ]
      : [{ kind: "return", value: lowerer.coerceToExpected(value, returnType), loc }];
  const stmts: IrStmt[] = [
    declare(
      iterator,
      check({
        kind: "libCall",
        fn: "dyn.iterator",
        args: [
          lowerer.coerceInto(expr.expression!, source, DYN),
          { kind: "strLit", value: "", type: STRING, loc },
        ],
        type: DYN,
        loc,
      }),
    ),
    declare(next, get(iterator.ref, "next")),
    declare(step, call(next.ref, [dynUndefinedExpr(loc)])),
    {
      kind: "while",
      cond: { kind: "unary", op: "!", operand: done(), type: BOOL, loc },
      body: [
        declare(resume, {
          kind: "yieldExpr",
          value: lowerer.coerceToExpected(get(step.ref, "value"), gen.yieldT),
          captureCompletion: { returnType },
          type: DYN,
          loc,
        }),
        {
          kind: "if",
          cond: mode(0),
          then: [assign(call(next.ref, [sent]))],
          else_: [
            {
              kind: "if",
              cond: mode(1),
              then: [
                declare(returned, get(iterator.ref, "return")),
                {
                  kind: "if",
                  cond: absent(returned.ref),
                  then: finish(sent),
                  else_: [
                    assign(call(returned.ref, [sent])),
                    {
                      kind: "if",
                      cond: done(),
                      then: finish(get(step.ref, "value")),
                      else_: null,
                      loc,
                    },
                  ],
                  loc,
                },
              ],
              else_: [
                declare(thrown, get(iterator.ref, "throw")),
                {
                  kind: "if",
                  cond: absent(thrown.ref),
                  then: [
                    declare(close, get(iterator.ref, "return")),
                    {
                      kind: "if",
                      cond: { kind: "unary", op: "!", operand: absent(close.ref), type: BOOL, loc },
                      then: [{ kind: "exprStmt", expr: call(close.ref, []), loc }],
                      else_: null,
                      loc,
                    },
                    {
                      kind: "throw",
                      value: {
                        kind: "libCall",
                        fn: "error.new",
                        args: [{ kind: "strLit", value: NO_THROW_METHOD, type: STRING, loc }],
                        type: { kind: "object", className: "%TypeError" },
                        loc,
                      },
                      loc,
                    },
                  ],
                  else_: [assign(call(thrown.ref, [sent]))],
                  loc,
                },
              ],
              loc,
            },
          ],
          loc,
        },
      ],
      loc,
    },
  ];
  const expected = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const result =
    expected && expected.kind !== "void"
      ? lowerer.coerceToExpected(get(step.ref, "value"), expected)
      : get(step.ref, "value");
  return { kind: "seqExpr", stmts, result, generatorDelegate: true, type: result.type, loc };
}

/** `yield* e` in an async generator: the async iterator protocol (a compiled
 * async generator, Symbol.asyncIterator's result, or a synchronous iterator
 * whose values are awaited). Each step's result is awaited, its values are
 * yielded, and the expression completes with the final result's value. An
 * abrupt completion at the yield (a consumer's return() or throw()) closes
 * the delegate through its return(), as for-await does; next() arguments
 * are not forwarded to the delegate. */
export function lowerAsyncDelegation(
  lowerer: Lowerer,
  expr: ts.YieldExpression,
  source: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const gen = lowerer.ctx.generator!;
  const slot = (name: string, type: IrType, mutable = false) => {
    const local = lowerer.declareHiddenLocal(name, type);
    local.mutable = mutable;
    return { local, ref: varRef(local.id, type, loc) };
  };
  const iterator = slot("%adelegate", DYN);
  const sync = slot("%adelegateSync", BOOL);
  const next = slot("%adelegateNext", DYN);
  const step = slot("%adelegateStep", DYN, true);
  const needsClose = slot("%adelegateClose", BOOL, true);
  const returned = slot("%adelegateReturn", DYN);
  const error = slot("%adelegateError", CAUGHT);
  const get = (value: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet",
    value,
    key: { kind: "strLit", value: key, type: STRING, loc },
    type: DYN,
    loc,
  });
  const awaitDyn = (value: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "async.awaitDyn",
    args: [value],
    type: DYN,
    loc,
  });
  // Each step's awaited result, which must be an object (TypeError
  // otherwise), for next() and return() alike.
  const invoke = (callee: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "dyn.iteratorResult",
    args: [
      awaitDyn({
        kind: "dynCall",
        callee,
        receiver: iterator.ref,
        calleeName: "iterator method",
        args: [],
        type: DYN,
        loc,
      }),
    ],
    type: DYN,
    loc,
  });
  const stepNext = invoke(next.ref);
  const setClose = (value: boolean): IrStmt => ({
    kind: "assign",
    localId: needsClose.local.id,
    value: { kind: "boolLit", value, type: BOOL, loc },
    loc,
  });
  const close = (): IrStmt[] => [
    { kind: "varDecl", localId: returned.local.id, init: get(iterator.ref, "return"), loc },
    {
      kind: "if",
      cond: {
        kind: "unary",
        op: "!",
        operand: { kind: "dynTest", test: "nullish", value: returned.ref, type: BOOL, loc },
        type: BOOL,
        loc,
      },
      then: [{ kind: "exprStmt", expr: invoke(returned.ref), loc }],
      else_: null,
      loc,
    },
  ];
  // A synchronous delegate's values are awaited, its final value too.
  const stepValue = (): IrExpr => ({
    kind: "ternary",
    cond: sync.ref,
    then: awaitDyn(get(step.ref, "value")),
    else_: get(step.ref, "value"),
    type: DYN,
    loc,
  });
  const yielded = stepValue();
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: iterator.local.id,
      init: {
        kind: "libCall",
        fn: "dyn.iteratorResult",
        args: [
          {
            kind: "libCall",
            fn: "dyn.asyncIteratorOpen",
            args: [source, { kind: "strLit", value: "", type: STRING, loc }],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      },
      loc,
    },
    {
      kind: "varDecl",
      localId: sync.local.id,
      init: { kind: "libCall", fn: "dyn.asyncIteratorWasSync", args: [], type: BOOL, loc },
      loc,
    },
    { kind: "varDecl", localId: next.local.id, init: get(iterator.ref, "next"), loc },
    {
      kind: "varDecl",
      localId: needsClose.local.id,
      init: { kind: "boolLit", value: false, type: BOOL, loc },
      loc,
    },
    { kind: "varDecl", localId: step.local.id, init: stepNext, loc },
    {
      kind: "tryCatch",
      tryBody: [
        {
          kind: "while",
          cond: {
            kind: "unary",
            op: "!",
            operand: {
              kind: "dynTest",
              test: "truthy",
              value: get(step.ref, "done"),
              type: BOOL,
              loc,
            },
            type: BOOL,
            loc,
          },
          body: [
            setClose(true),
            {
              kind: "exprStmt",
              expr: {
                kind: "yieldExpr",
                value: lowerer.coerceToExpected(yielded, gen.yieldT),
                type: gen.nextT.kind === "undefinedT" ? VOID : gen.nextT,
                loc,
              },
              loc,
            },
            setClose(false),
            { kind: "assign", localId: step.local.id, value: stepNext, loc },
          ],
          loc,
        },
      ],
      catchBody: [
        {
          kind: "if",
          cond: needsClose.ref,
          then: [
            setClose(false),
            {
              kind: "tryCatch",
              tryBody: close(),
              catchBody: [],
              catchLocalId: null,
              finallyBody: null,
              loc,
            },
          ],
          else_: null,
          loc,
        },
        { kind: "rethrow", localId: error.local.id, loc },
      ],
      catchLocalId: error.local.id,
      finallyBody: [{ kind: "if", cond: needsClose.ref, then: close(), else_: null, loc }],
      loc,
    },
  ];
  const expected = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const result =
    expected && expected.kind !== "void"
      ? lowerer.coerceToExpected(stepValue(), expected)
      : stepValue();
  return { kind: "seqExpr", stmts, result, generatorDelegate: true, type: result.type, loc };
}

/** `yield* xs` over an array, a string, a Set or a Map: the built-in
 * iterator walked in place, with the same live view as for-of (an array
 * re-reads its length every step, a string steps by code point, a Map
 * yields fresh [key, value] entries). These iterators have no return() or
 * throw() methods: a consumer's next(v) drops v, return(v) completes the
 * outer generator at the yield, and throw(e) raises a TypeError there
 * instead of e. The expression completes with undefined. */
export function lowerBuiltinDelegation(
  lowerer: Lowerer,
  expr: ts.YieldExpression,
  source: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const gen = lowerer.ctx.generator!;
  const sourceT = source.type;
  const container = lowerer.declareHiddenLocal("%delegate", sourceT);
  const cursor = lowerer.declareHiddenLocal("%delegateCursor", F64);
  cursor.mutable = true;
  const src = (): IrExpr => varRef(container.id, sourceT, loc);
  const at = (): IrExpr => varRef(cursor.id, F64, loc);
  const advance = (by: IrExpr): IrStmt => ({
    kind: "assign",
    localId: cursor.id,
    value: { kind: "bin", op: "+", left: at(), right: by, type: F64, loc },
    loc,
  });
  const below = (bound: IrExpr): IrExpr => ({
    kind: "bin",
    op: "<",
    left: at(),
    right: bound,
    type: BOOL,
    loc,
  });
  // One delegated step: the value converts into the outer yield channel
  // first, so only the resumption itself is inside the try.
  const step = (value: IrExpr): IrStmt[] => {
    const prefix: IrStmt[] = [];
    let yielded = value;
    if (value.kind !== "varRef" || !typeEquals(value.type, gen.yieldT)) {
      const local = lowerer.declareHiddenLocal("%delegateValue", gen.yieldT);
      prefix.push({
        kind: "varDecl",
        localId: local.id,
        init: lowerer.coerceInto(expr.expression!, value, gen.yieldT),
        loc,
      });
      yielded = varRef(local.id, gen.yieldT, loc);
    }
    return [
      ...prefix,
      {
        kind: "tryCatch",
        tryBody: [
          {
            kind: "exprStmt",
            expr: {
              kind: "yieldExpr",
              value: yielded,
              type: gen.nextT.kind === "undefinedT" ? VOID : gen.nextT,
              loc,
            },
            loc,
          },
        ],
        catchBody: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [{ kind: "strLit", value: NO_THROW_METHOD, type: STRING, loc }],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        catchLocalId: null,
        finallyBody: null,
        loc,
      },
    ];
  };
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: container.id, init: source, loc },
    { kind: "varDecl", localId: cursor.id, init: numLit(0, loc), loc },
  ];
  if (sourceT.kind === "array") {
    // A present element converts straight from the dense read; a hole or
    // a stored undefined takes the optional read, as Get does.
    const read: IrExpr = {
      kind: "ternary",
      cond: {
        kind: "bin",
        op: "===",
        left: { kind: "arrayState", arr: src(), index: at(), type: F64, loc },
        right: numLit(1, loc),
        type: BOOL,
        loc,
      },
      then: lowerer.coerceInto(
        expr.expression!,
        { kind: "arrayGet", arr: src(), index: at(), type: sourceT.elem, loc },
        gen.yieldT,
      ),
      else_: lowerer.coerceInto(
        expr.expression!,
        arrayValueRead(lowerer, src(), at(), sourceT.elem, loc),
        gen.yieldT,
      ),
      type: gen.yieldT,
      loc,
    };
    const element = lowerer.declareHiddenLocal("%delegateElement", read.type);
    stmts.push({
      kind: "while",
      cond: below({
        kind: "arrIntrinsic",
        method: "length",
        receiver: src(),
        args: [],
        type: F64,
        loc,
      }),
      body: [
        { kind: "varDecl", localId: element.id, init: read, loc },
        advance(numLit(1, loc)),
        ...step(varRef(element.id, read.type, loc)),
      ],
      loc,
    });
  } else if (sourceT.kind === "string") {
    // A byte cursor over the WTF-8 data, as for-of over a string walks.
    const ch = lowerer.declareHiddenLocal("%delegateElement", STRING);
    const length = (receiver: IrExpr): IrExpr => ({
      kind: "strIntrinsic",
      method: "byteLength",
      receiver,
      args: [],
      type: F64,
      loc,
    });
    stmts.push({
      kind: "while",
      cond: below(length(src())),
      body: [
        {
          kind: "varDecl",
          localId: ch.id,
          init: {
            kind: "strIntrinsic",
            method: "cpAtByte",
            receiver: src(),
            args: [at()],
            type: STRING,
            loc,
          },
          loc,
        },
        advance(length(varRef(ch.id, STRING, loc))),
        ...step(varRef(ch.id, STRING, loc)),
      ],
      loc,
    });
  } else if (sourceT.kind === "map" || sourceT.kind === "set") {
    const iter = (method: string, args: IrExpr[], type: IrType): IrExpr =>
      sourceT.kind === "map"
        ? {
            kind: "mapIntrinsic",
            method: method as IrMapIntrinsicMethod,
            receiver: src(),
            args,
            type,
            loc,
          }
        : {
            kind: "setIntrinsic",
            method: method as IrSetIntrinsicMethod,
            receiver: src(),
            args,
            type,
            loc,
          };
    const keyT = sourceT.kind === "map" ? sourceT.key : sourceT.elem;
    const index = lowerer.declareHiddenLocal("%delegateIndex", F64);
    const key = (): IrExpr => iter("iterKey", [varRef(index.id, F64, loc)], keyT);
    let element: IrExpr = key();
    if (sourceT.kind === "map") {
      const entryT: IrType = {
        kind: "record",
        shapeId: lowerer.shapes.intern(
          [
            { name: "0", type: keyT },
            { name: "1", type: sourceT.value },
          ],
          true,
        ),
      };
      element = {
        kind: "recordLit",
        fields: [
          { name: "0", value: key() },
          { name: "1", value: iter("iterValue", [varRef(index.id, F64, loc)], sourceT.value) },
        ],
        type: entryT,
        loc,
      };
    }
    const exit: IrStmt = { kind: "exprStmt", expr: iter("iterExit", [], VOID), loc };
    stmts.push(
      { kind: "exprStmt", expr: iter("iterEnter", [], VOID), loc },
      {
        kind: "tryCatch",
        tryBody: [
          {
            kind: "while",
            cond: below(iter("iterCount", [], F64)),
            body: [
              { kind: "varDecl", localId: index.id, init: at(), loc },
              advance(numLit(1, loc)),
              {
                kind: "if",
                cond: iter("iterLive", [varRef(index.id, F64, loc)], BOOL),
                then: step(element),
                else_: null,
                loc,
              },
            ],
            loc,
          },
        ],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [exit],
        loc,
      },
    );
  }
  const expected = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const done = dynUndefinedExpr(loc);
  const result =
    expected && expected.kind !== "void" ? lowerer.coerceToExpected(done, expected) : done;
  return { kind: "seqExpr", stmts, result, generatorDelegate: true, type: result.type, loc };
}
