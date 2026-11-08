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

/** `yield* e` in an async generator: the spec's delegation loop over the
 * async iterator protocol. A compiled async generator, a
 * Symbol.asyncIterator result, or a synchronous iterator is walked one
 * step at a time (a synchronous one's values, and its final value, are
 * awaited the way the AsyncFromSyncIterator continuation awaits them).
 * Every completion the generator receives at the delegated yield is
 * forwarded to the delegate: next(v) calls the cached next method,
 * throw(e) calls throw, return(v) calls return. The step's result is
 * awaited for an async delegate, must be an object, and its done then
 * value are read — so an abrupt accessor rejects from the step the spec
 * reads it in. A done step completes the expression with its value,
 * except after a return completion, which completes the generator. A
 * delegate with no throw method is closed through return() and then
 * throws Node's TypeError; a delegate with no return method makes the
 * awaited received value the generator's completion. */
export function lowerAsyncDelegation(
  lowerer: Lowerer,
  expr: ts.YieldExpression,
  source: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const gen = lowerer.ctx.generator!;
  const returnType = lowerer.ctx.returnType;
  // The received completion crosses to the delegate as a checked value,
  // so the channels it is read from and written to must cross as well
  // (the same fence the checked sync delegation uses).
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
        "async delegation with a channel that cannot cross a checked iterator method",
      );
    }
  }
  // A `never` yield channel (the VOID sentinel: a generator that never
  // yields) has no operand form — the delegate's values cannot be named in
  // it — but the protocol still runs: the delegate's steps, their thrown
  // errors (with the error's identity) and its completion are the whole of
  // the delegation. Only a non-done step, impossible in a well-typed
  // program, ends in the unreachable trap below. An `undefined` channel is
  // a real suspension whose values would have to be undefined; it keeps
  // the plain refusal.
  if (gen.yieldT.kind === "undefinedT") {
    lowerer.unsupported(
      "SC1071",
      expr,
      "async delegation in a generator whose yield type is undefined (annotate the generator's yield type)",
    );
  }
  const slot = (name: string, type: IrType, init: IrExpr) => {
    const local = lowerer.declareHiddenLocal(name, type);
    local.mutable = true;
    return { local, ref: varRef(local.id, type, loc), init };
  };
  const iterator = slot("%adelegate", DYN, dynUndefinedExpr(loc));
  const sync = slot("%adelegateSync", BOOL, { kind: "boolLit", value: false, type: BOOL, loc });
  const next = slot("%adelegateNext", DYN, dynUndefinedExpr(loc));
  const kind = slot("%adelegateKind", F64, { kind: "numLit", value: 0, type: F64, loc });
  const sent = slot("%adelegateSent", DYN, dynUndefinedExpr(loc));
  const step = slot("%adelegateStep", DYN, dynUndefinedExpr(loc));
  const value = slot("%adelegateValue", DYN, dynUndefinedExpr(loc));
  const method = slot("%adelegateMethod", DYN, dynUndefinedExpr(loc));
  const resume = slot("%adelegateResume", DYN, dynUndefinedExpr(loc));
  const done = slot("%adelegateDone", BOOL, { kind: "boolLit", value: false, type: BOOL, loc });
  const finished = slot("%adelegateFinished", BOOL, {
    kind: "boolLit",
    value: false,
    type: BOOL,
    loc,
  });
  const returning = slot("%adelegateReturning", BOOL, {
    kind: "boolLit",
    value: false,
    type: BOOL,
    loc,
  });
  const get = (target: IrExpr, key: string): IrExpr => ({
    kind: "dynKeyGet",
    value: target,
    key: { kind: "strLit", value: key, type: STRING, loc },
    type: DYN,
    loc,
  });
  const check = (target: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "dyn.iteratorResult",
    args: [target],
    type: DYN,
    loc,
  });
  const awaitDyn = (target: IrExpr): IrExpr => ({
    kind: "libCall",
    fn: "async.awaitDyn",
    args: [target],
    type: DYN,
    loc,
  });
  const call = (callee: IrExpr, args: IrExpr[]): IrExpr => ({
    kind: "dynCall",
    callee,
    receiver: iterator.ref,
    calleeName: "iterator method",
    args,
    type: DYN,
    loc,
  });
  const assign = (target: { local: { id: string } }, v: IrExpr): IrStmt => ({
    kind: "assign",
    localId: target.local.id,
    value: v,
    loc,
  });
  const test = (target: IrExpr, which: "nullish" | "truthy" | "undefined"): IrExpr => ({
    kind: "dynTest",
    test: which,
    value: target,
    type: BOOL,
    loc,
  });
  const not = (operand: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand, type: BOOL, loc });
  const num = (v: number): IrExpr => ({ kind: "numLit", value: v, type: F64, loc });
  const modeIs = (n: number): IrExpr => ({
    kind: "bin",
    op: "===",
    left: kind.ref,
    right: num(n),
    type: BOOL,
    loc,
  });
  const setFinished = (): IrStmt =>
    assign(finished, {
      kind: "boolLit",
      value: true,
      type: BOOL,
      loc,
    });
  /** One protocol call into the delegate's `callee`: the raw result, the
   * await an async delegate takes on it, then the object requirement. A
   * synchronous delegate answers a plain result, so the await is skipped. */
  const invoke = (callee: IrExpr, args: IrExpr[]): IrStmt[] => [
    assign(step, call(callee, args)),
    { kind: "if", cond: not(sync.ref), then: [assign(step, awaitDyn(step.ref))], else_: null, loc },
    assign(step, check(step.ref)),
  ];
  /** The delegate has no throw method: close it through return(), then
   * throw Node's TypeError. */
  const closeThenThrow: IrStmt[] = [
    assign(method, get(iterator.ref, "return")),
    {
      kind: "if",
      cond: not(test(method.ref, "nullish")),
      then: invoke(method.ref, []),
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
  ];
  /** IteratorClose with a throw completion: call the delegate's return()
   * when it has one, and drop whatever it answers or throws, so the pending
   * error is the one that propagates. */
  const rejection = lowerer.declareHiddenLocal("%adelegateRejection", CAUGHT);
  const closeQuietly: IrStmt[] = [
    {
      kind: "tryCatch",
      tryBody: [
        assign(method, get(iterator.ref, "return")),
        {
          kind: "if",
          cond: not(test(method.ref, "nullish")),
          then: [{ kind: "exprStmt", expr: call(method.ref, []), loc }],
          else_: null,
          loc,
        },
      ],
      catchLocalId: null,
      catchBody: [],
      finallyBody: null,
      loc,
    },
  ];
  /** A return completion of the delegating generator: the value is already
   * settled (awaited), so the request settles at completion. */
  const finish: IrStmt[] =
    returnType.kind === "void"
      ? [
          {
            kind: "if",
            cond: not(test(value.ref, "undefined")),
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
          { kind: "return", value: null, awaited: true, loc },
        ]
      : [
          {
            kind: "return",
            value: lowerer.coerceInto(expr, value.ref, returnType),
            awaited: true,
            loc,
          },
        ];
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: iterator.local.id,
      init: check({
        kind: "libCall",
        fn: "dyn.asyncIteratorOpen",
        args: [source, { kind: "strLit", value: "", type: STRING, loc }],
        type: DYN,
        loc,
      }),
      loc,
    },
    {
      kind: "varDecl",
      localId: sync.local.id,
      init: { kind: "libCall", fn: "dyn.asyncIteratorWasSync", args: [], type: BOOL, loc },
      loc,
    },
    { kind: "varDecl", localId: next.local.id, init: get(iterator.ref, "next"), loc },
    ...[kind, sent, step, value, method, resume, done, finished, returning].map((s) => ({
      kind: "varDecl" as const,
      localId: s.local.id,
      init: s.init,
      loc,
    })),
    {
      kind: "while",
      cond: not(finished.ref),
      body: [
        // A return completion makes this loop's done result the
        // generator's own completion instead of the expression's value.
        assign(returning, modeIs(1)),
        {
          kind: "if",
          cond: modeIs(0),
          then: invoke(next.ref, [sent.ref]),
          else_: [
            {
              kind: "if",
              cond: modeIs(1),
              then: [
                assign(method, get(iterator.ref, "return")),
                {
                  kind: "if",
                  cond: test(method.ref, "nullish"),
                  // No return method: the awaited received value is the
                  // generator's completion.
                  then: [assign(value, awaitDyn(sent.ref)), setFinished()],
                  else_: invoke(method.ref, [sent.ref]),
                  loc,
                },
              ],
              else_: [
                assign(method, get(iterator.ref, "throw")),
                {
                  kind: "if",
                  cond: test(method.ref, "nullish"),
                  then: closeThenThrow,
                  else_: invoke(method.ref, [sent.ref]),
                  loc,
                },
              ],
              loc,
            },
          ],
          loc,
        },
        {
          kind: "if",
          cond: not(finished.ref),
          then: [
            // done, then value, in the spec's order: an abrupt accessor
            // is observed at the step that reads it. A synchronous
            // delegate's value is awaited in both positions.
            assign(done, test(get(step.ref, "done"), "truthy")),
            assign(value, get(step.ref, "value")),
            {
              kind: "if",
              cond: sync.ref,
              then: [
                {
                  kind: "if",
                  // A rejected value of a step that is not done, answering
                  // next() or throw(), closes the delegate before the
                  // rejection propagates (AsyncFromSyncIteratorContinuation's
                  // closeOnRejection); a return() step's is passed through.
                  cond: {
                    kind: "logical",
                    op: "&&",
                    left: not(done.ref),
                    right: not(returning.ref),
                    type: BOOL,
                    loc,
                  },
                  then: [
                    {
                      kind: "tryCatch",
                      tryBody: [assign(value, awaitDyn(value.ref))],
                      catchLocalId: rejection.id,
                      catchBody: [...closeQuietly, { kind: "rethrow", localId: rejection.id, loc }],
                      finallyBody: null,
                      loc,
                    },
                  ],
                  else_: [assign(value, awaitDyn(value.ref))],
                  loc,
                },
              ],
              else_: null,
              loc,
            },
            {
              kind: "if",
              cond: done.ref,
              then: [setFinished()],
              else_:
                gen.yieldT.kind === "void"
                  ? [
                      // A value step on a `never` channel: the type says the
                      // delegate never yields, so this is unreachable. Fail
                      // loudly rather than store a void operand (rc:void).
                      {
                        kind: "runtimeFence",
                        code: "SC9002",
                        message:
                          "unreachable: an async delegate yielded a value into a 'never' channel — please report this",
                        loc,
                      },
                    ]
                  : [
                      // An assignment, not a declaration: the slot already owns
                      // one scope entry (declared with the other leftovers), and
                      // a second one would release it at the loop's own exit and
                      // again at the function scope's.
                      assign(resume, {
                        kind: "yieldExpr",
                        value: lowerer.coerceInto(expr, value.ref, gen.yieldT),
                        captureCompletion: { returnType },
                        type: DYN,
                        loc,
                      }),
                      assign(kind, {
                        kind: "dynCheck",
                        value: get(resume.ref, "kind"),
                        type: F64,
                        loc,
                      }),
                      assign(sent, get(resume.ref, "value")),
                    ],
              loc,
            },
          ],
          else_: null,
          loc,
        },
      ],
      loc,
    },
    { kind: "if", cond: returning.ref, then: finish, else_: null, loc },
  ];
  const expected = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const result =
    expected && expected.kind !== "void"
      ? lowerer.coerceInto(expr, value.ref, expected)
      : value.ref;
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
