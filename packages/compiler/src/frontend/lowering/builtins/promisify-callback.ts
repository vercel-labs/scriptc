import { keyedHelperName } from "../stable-names.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import { isJsSourceFile } from "../../program.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  type SrcLoc,
  VOID,
  funcOf,
  isUnitType,
  typeEquals,
  typeKey,
} from "../../../ir/ir.js";

const ERROR_T: IrType = { kind: "object", className: "%Error" };

/** The parts of `util.promisify(fn)` for a typed callback-last function:
 * `fn(...args, (err, value) => void)` becomes `(...args) => Promise<T>`. */
export interface CallbackShape {
  fnT: IrType & { kind: "func" };
  resultT: IrType & { kind: "func" };
  args: readonly IrType[];
  callbackT: IrType & { kind: "func" };
  /** The parameter's declared type: callbackT, or `callbackT | undefined`
   * for an optional callback. */
  callbackParamT: IrType;
  inner: IrType;
  /** The error parameter's union and the tag of its Error arm, or null when
   * the callback declares no error parameter. */
  error: { type: IrType; errorTag: number; unitTags: number[] } | null;
}

function callbackShape(
  lowerer: Lowerer,
  fnT: IrType | null,
  resultT: IrType | null,
  loc: SrcLoc,
): CallbackShape | null {
  if (fnT?.kind !== "func" || resultT?.kind !== "func") return null;
  if (fnT.rest || fnT.restAbi || fnT.argumentsAll || resultT.rest || resultT.restAbi) return null;
  const callbackParamT = fnT.params[fnT.params.length - 1];
  // An optional callback (`close(callback?: (err?: Error) => void)`) takes
  // its function arm; the call passes the callback into the union.
  const callbackT =
    callbackParamT?.kind === "union"
      ? (() => {
          const arms = lowerer.unions.get(callbackParamT.unionId)?.arms ?? [];
          const fns = arms.filter((arm) => arm.kind === "func");
          return fns.length === 1 &&
            arms.every((arm) => arm.kind === "func" || arm.kind === "undefinedT")
            ? fns[0]
            : undefined;
        })()
      : callbackParamT;
  if (callbackT?.kind !== "func" || callbackT.ret.kind !== "void") return null;
  if (callbackT.rest || callbackT.restAbi || callbackT.params.length > 2) return null;
  const args = fnT.params.slice(0, -1);
  if (
    resultT.ret.kind !== "promise" ||
    resultT.params.length !== args.length ||
    !resultT.params.every((type, i) => typeEquals(type, args[i]!))
  )
    return null;
  const inner = resultT.ret.inner;
  let error: CallbackShape["error"] = null;
  const errorT = callbackT.params[0];
  if (errorT !== undefined) {
    if (errorT.kind !== "union") return null;
    const arms = lowerer.unions.get(errorT.unionId)?.arms ?? [];
    const errorTags = arms.flatMap((arm, tag) =>
      arm.kind === "object" &&
      (arm.className === "%Error" || lowerer.isSubclassOf(arm.className, "%Error"))
        ? [tag]
        : [],
    );
    const unitTags = arms.flatMap((arm, tag) => (isUnitType(arm) ? [tag] : []));
    if (errorTags.length !== 1 || errorTags.length + unitTags.length !== arms.length) return null;
    error = { type: errorT, errorTag: errorTags[0]!, unitTags };
  }
  if (inner.kind !== "void") {
    const valueT = callbackT.params[1];
    if (valueT === undefined) return null;
    const probe: IrExpr = { kind: "varRef", localId: "%probe", type: valueT, loc };
    if (!typeEquals(lowerer.coerceToExpected(probe, inner).type, inner)) return null;
  }
  return { fnT, resultT, args, callbackT, callbackParamT: callbackParamT!, inner, error };
}

/** Whether `promisify(fn)`'s one argument is only known at run time, so
 * the promisified function is built there: a value typed `any`, a function
 * with untyped parameters (the declarations type that call `any`), or any
 * argument in JavaScript, whose inferred types do not describe the
 * function Node receives (it validates the argument and reads its own
 * properties). */
export function untypedPromisifyArgument(lowerer: Lowerer, call: ts.CallExpression): boolean {
  if (call.questionDotToken || call.arguments.nodes.length > 1) return false;
  const argNode = call.arguments.nodes[0];
  if (argNode !== undefined && ts.isSpreadElement(argNode)) return false;
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) return true;
  if (argNode === undefined) return false;
  return (
    (lowerer.typeOf(argNode).flags & ts.TypeFlags.Any) !== 0 ||
    (lowerer.typeOf(call).flags & ts.TypeFlags.Any) !== 0
  );
}

/** The callback shape of a `promisify(fn)` call, or null. */
export function callbackPromisifyShape(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): CallbackShape | null {
  if (call.questionDotToken || call.arguments.nodes.length !== 1) return null;
  const argNode = call.arguments.nodes[0]!;
  if (ts.isSpreadElement(argNode)) return null;
  return callbackShape(
    lowerer,
    lowerer.mapTypeOf(lowerer.typeOf(argNode)),
    lowerer.mapTypeOf(lowerer.typeOf(call)),
    loc,
  );
}

function captureParam(localId: string, type: IrType): IrParam {
  return { localId, name: localId, type };
}

function boxedLocal(localId: string, type: IrType): IrLocal {
  return { id: localId, name: localId, type, mutable: false, boxed: true };
}

function plainLocal(localId: string, type: IrType): IrLocal {
  return { id: localId, name: localId, type, mutable: false };
}

/** `util.promisify(fn)` over a typed callback-last function value (a bound
 * method, a function declaration, a closure): a native function that calls
 * `fn` with the arguments and a callback, and settles its promise from the
 * callback like Node's wrapper: a truthy error rejects, otherwise the first
 * value fulfills. A synchronous throw rejects (the executor's rule). Null
 * when the argument or result does not have that typed shape. */
export function lowerCallbackPromisify(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  const shape = callbackPromisifyShape(lowerer, call, loc);
  if (shape === null) {
    // An untyped (`any`) function: Node's promisify at run time.
    if (!untypedPromisifyArgument(lowerer, call)) return null;
    const argNode = call.arguments.nodes[0];
    return {
      kind: "libCall",
      fn: "util.promisifyDyn",
      args: [argNode ? lowerer.lowerExprExpecting(argNode, DYN) : dynUndefinedExpr(loc)],
      type: DYN,
      loc,
    };
  }
  const argNode = call.arguments.nodes[0]!;
  let fn = lowerer.lowerExpr(argNode);
  if (!typeEquals(fn.type, shape.fnT)) fn = lowerer.coerceToExpected(fn, shape.fnT);
  if (!typeEquals(fn.type, shape.fnT)) return null;
  return {
    kind: "call",
    callee: promisifyMaker(lowerer, shape, loc),
    args: [fn],
    type: shape.resultT,
    loc,
  };
}

/** Interns the helper family for one (function, result) type pair and
 * answers the maker: `(fn) => closure(...args) => Promise<T>`. */
function promisifyMaker(lowerer: Lowerer, shape: CallbackShape, loc: SrcLoc): string {
  const key = `promisify:${typeKey(shape.fnT)}=>${typeKey(shape.resultT)}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const base = keyedHelperName(lowerer, "%promisify", key);
  lowerer.arrHofHelpers.set(key, base);
  const { fnT, resultT, args, callbackT, callbackParamT, inner, error } = shape;
  const promiseT = resultT.ret;
  const resolveT = funcOf(inner.kind === "void" ? [] : [inner], VOID);
  const rejectT = funcOf([ERROR_T], VOID);
  const executorT = funcOf([resolveT, rejectT], VOID);
  const argIds = args.map((_, i) => `a${i}.0`);

  // The callback: (err, value) => err ? reject(err) : resolve(value).
  const cbParams: IrParam[] = [];
  callbackT.params.forEach((type, i) =>
    cbParams.push(captureParam(i === 0 ? "err.0" : "value.0", type)),
  );
  const cbBody: IrStmt[] = [];
  if (error !== null) {
    const err = varRef("err.0", error.type, loc);
    let truthy: IrExpr | null = null;
    for (const tag of error.unitTags) {
      const part: IrExpr = {
        kind: "unionIsTag",
        unionId: (error.type as IrType & { kind: "union" }).unionId,
        tag,
        negated: true,
        value: err,
        type: BOOL,
        loc,
      };
      truthy =
        truthy === null
          ? part
          : { kind: "logical", op: "&&", left: truthy, right: part, type: BOOL, loc };
    }
    const errorArm = lowerer.unions.get((error.type as IrType & { kind: "union" }).unionId)!.arms[
      error.errorTag
    ]!;
    let reason: IrExpr = {
      kind: "unionNarrow",
      unionId: (error.type as IrType & { kind: "union" }).unionId,
      tag: error.errorTag,
      value: err,
      type: errorArm,
      loc,
    };
    if (!typeEquals(errorArm, ERROR_T))
      reason = { kind: "upcast", value: reason, type: ERROR_T, loc };
    const reject: IrStmt[] = [
      {
        kind: "exprStmt",
        expr: {
          kind: "callValue",
          callee: varRef("rej.0", rejectT, loc),
          args: [reason],
          type: VOID,
          loc,
        },
        loc,
      },
      { kind: "return", value: null, loc },
    ];
    cbBody.push(
      truthy === null ? reject[0]! : { kind: "if", cond: truthy, then: reject, else_: null, loc },
    );
    if (truthy === null) cbBody.push(reject[1]!);
  }
  const value =
    inner.kind === "void"
      ? []
      : [lowerer.coerceToExpected(varRef("value.0", callbackT.params[1]!, loc), inner)];
  cbBody.push({
    kind: "exprStmt",
    expr: {
      kind: "callValue",
      callee: varRef("res.0", resolveT, loc),
      args: value,
      type: VOID,
      loc,
    },
    loc,
  });
  lowerer.liftedFns.push({
    name: `${base}.cb`,
    params: cbParams,
    returnType: VOID,
    captures: [captureParam("res.0", resolveT), captureParam("rej.0", rejectT)],
    locals: [
      boxedLocal("res.0", resolveT),
      boxedLocal("rej.0", rejectT),
      ...cbParams.map((p) => plainLocal(p.localId, p.type)),
    ],
    body: cbBody,
    loc,
  });
  lowerer.liftedFns.push({
    name: `${base}.mkcb`,
    params: [captureParam("res.0", resolveT), captureParam("rej.0", rejectT)],
    returnType: callbackT,
    locals: [boxedLocal("res.0", resolveT), boxedLocal("rej.0", rejectT)],
    body: [
      {
        kind: "return",
        value: {
          kind: "closure",
          fnName: `${base}.cb`,
          captures: ["res.0", "rej.0"],
          type: callbackT,
          loc,
        },
        loc,
      },
    ],
    loc,
  });

  // The executor: (resolve, reject) => fn(...args, callback).
  const captured: IrParam[] = [captureParam("f.0", fnT)];
  args.forEach((type, i) => captured.push(captureParam(argIds[i]!, type)));
  lowerer.liftedFns.push({
    name: `${base}.exec`,
    params: [captureParam("res.0", resolveT), captureParam("rej.0", rejectT)],
    returnType: VOID,
    captures: captured,
    locals: [
      ...captured.map((p) => boxedLocal(p.localId, p.type)),
      plainLocal("res.0", resolveT),
      plainLocal("rej.0", rejectT),
    ],
    body: [
      {
        kind: "exprStmt",
        expr: {
          kind: "callValue",
          callee: varRef("f.0", fnT, loc),
          args: [
            ...args.map((type, i) => varRef(argIds[i]!, type, loc)),
            lowerer.coerceToExpected(
              {
                kind: "call",
                callee: `${base}.mkcb`,
                args: [varRef("res.0", resolveT, loc), varRef("rej.0", rejectT, loc)],
                type: callbackT,
                loc,
              },
              callbackParamT,
            ),
          ],
          // The function's own return type; the value is discarded.
          type: fnT.ret,
          loc,
        },
        loc,
      },
    ],
    loc,
  });
  lowerer.liftedFns.push({
    name: `${base}.mkexec`,
    params: captured,
    returnType: executorT,
    locals: captured.map((p) => boxedLocal(p.localId, p.type)),
    body: [
      {
        kind: "return",
        value: {
          kind: "closure",
          fnName: `${base}.exec`,
          captures: captured.map((p) => p.localId),
          type: executorT,
          loc,
        },
        loc,
      },
    ],
    loc,
  });

  // The promisified function: (...args) => new Promise(executor).
  const implParams: IrParam[] = [];
  args.forEach((type, i) => implParams.push(captureParam(argIds[i]!, type)));
  lowerer.liftedFns.push({
    name: `${base}.impl`,
    params: implParams,
    returnType: promiseT,
    captures: [captureParam("f.0", fnT)],
    locals: [boxedLocal("f.0", fnT), ...implParams.map((p) => plainLocal(p.localId, p.type))],
    body: [
      {
        kind: "return",
        value: {
          kind: "newPromise",
          executor: {
            kind: "call",
            callee: `${base}.mkexec`,
            args: [
              varRef("f.0", fnT, loc),
              ...implParams.map((p) => varRef(p.localId, p.type, loc)),
            ],
            type: executorT,
            loc,
          },
          type: promiseT,
          loc,
        },
        loc,
      },
    ],
    loc,
  });
  lowerer.liftedFns.push({
    name: base,
    params: [captureParam("f.0", fnT)],
    returnType: resultT,
    locals: [boxedLocal("f.0", fnT)],
    body: [
      {
        kind: "return",
        value: { kind: "closure", fnName: `${base}.impl`, captures: ["f.0"], type: resultT, loc },
        loc,
      },
    ],
    loc,
  });
  return base;
}
