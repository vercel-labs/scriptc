/* A callback called with a fixed call-time receiver: the `thisArg` of
 * `forEach(fn, thisArg)` and its siblings. The callback value is wrapped in
 * a closure that invokes it with the receiver (`callValue`'s receiver), so
 * a function reading `this` sees the receiver exactly as `fn.call(thisArg,
 * ...)` would. Object receivers cross as live references (identity kept). */
import * as ts from "../ts7/syntax.js";
import {
  DYN,
  typeKey,
  type IrExpr,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { typedThisParameter } from "./lower-functions.js";
import { keyedHelperName } from "./stable-names.js";

/** A function declaration with a typed `this` (its first IR parameter,
 * lower-functions.ts typedThisParameter) named by `callee`: its IR name,
 * signature and receiver type. */
export function typedReceiverFunction(
  lowerer: Lowerer,
  callee: ts.Expression,
): { name: string; thisType: IrType; params: IrType[]; ret: IrType } | null {
  let e = callee;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e)) return null;
  const symbol = lowerer.resolveValueSymbol(e);
  const decl = symbol?.declarations[0];
  if (!symbol || decl === undefined || !ts.isFunctionDeclaration(decl)) return null;
  const thisType = typedThisParameter(lowerer, decl);
  const sig = lowerer.fnSigsBySymbol.get(symbol);
  if (thisType === null || sig === undefined) return null;
  return { name: sig.name, thisType, params: sig.params.map((p) => p.type), ret: sig.returnType };
}

/** `fn(...)` with a typed `this` bound to `receiverNode`: a closure over the
 * receiver that calls the function directly. */
function bindTypedReceiver(
  lowerer: Lowerer,
  fn: NonNullable<ReturnType<typeof typedReceiverFunction>>,
  receiverNode: ts.Expression,
): IrExpr {
  const loc = locOf(receiverNode);
  lowerer.noteEdge(fn.name);
  const type: IrType = { kind: "func", params: fn.params, ret: fn.ret };
  const key = `receiver.typed:${fn.name}`;
  let name: string | undefined = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%receiver.call", key) as string;
    lowerer.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const t: IrLocal = { id: "t.0", name: "t", type: fn.thisType, mutable: false, boxed: true };
    const params: IrParam[] = fn.params.map((type, i) => ({
      localId: `p.${i}`,
      name: `p${i}`,
      type,
    }));
    const invoked: IrExpr = {
      kind: "call",
      callee: fn.name,
      args: [
        { kind: "varRef", localId: t.id, type: fn.thisType, loc },
        ...params.map((p): IrExpr => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
      ],
      type: fn.ret,
      loc,
    };
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: fn.ret,
      captures: [{ localId: t.id, name: t.name, type: fn.thisType }],
      locals: [
        t,
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      ],
      body: [
        fn.ret.kind === "void"
          ? { kind: "exprStmt", expr: invoked, loc }
          : { kind: "return", value: invoked, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: t.id, name: t.name, type: fn.thisType }],
      returnType: type,
      locals: [t],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: [t.id], type, loc },
          loc,
        },
      ],
      loc,
    });
  }
  const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(receiverNode), fn.thisType);
  return { kind: "call", callee: name, args: [receiver], type, loc };
}

/** The callback expression `fnNode` bound to the receiver `receiverNode`. */
export function bindCallReceiver(
  lowerer: Lowerer,
  fnNode: ts.Expression,
  receiverNode: ts.Expression,
): IrExpr {
  const typed = typedReceiverFunction(lowerer, fnNode);
  if (typed !== null) return bindTypedReceiver(lowerer, typed, receiverNode);
  const fn = lowerer.lowerExpr(fnNode);
  if (fn.type.kind !== "func") return fn;
  const type = fn.type as IrType & { kind: "func" };
  const loc = locOf(receiverNode);
  const key = `receiver.bind:${typeKey(type)}`;
  let name: string | undefined = lowerer.arrHofHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%receiver.bind", key) as string;
    lowerer.arrHofHelpers.set(key, name);
    const impl = `${name}.impl`;
    const f: IrLocal = { id: "f.0", name: "f", type, mutable: false, boxed: true };
    const t: IrLocal = { id: "t.0", name: "t", type: DYN, mutable: false, boxed: true };
    const params: IrParam[] = type.params.map((type, i) => ({
      localId: `p.${i}`,
      name: `p${i}`,
      type,
    }));
    const invoked: IrExpr = {
      kind: "callValue",
      callee: { kind: "varRef", localId: f.id, type, loc },
      receiver: { kind: "varRef", localId: t.id, type: DYN, loc },
      args: params.map((p) => ({ kind: "varRef", localId: p.localId, type: p.type, loc })),
      type: type.ret,
      loc,
    };
    lowerer.liftedFns.push({
      name: impl,
      params,
      returnType: type.ret,
      captures: [
        { localId: f.id, name: f.name, type },
        { localId: t.id, name: t.name, type: DYN },
      ],
      locals: [
        f,
        t,
        ...params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      ],
      body: [
        type.ret.kind === "void"
          ? { kind: "exprStmt", expr: invoked, loc }
          : { kind: "return", value: invoked, loc },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: f.id, name: f.name, type },
        { localId: t.id, name: t.name, type: DYN },
      ],
      returnType: type,
      locals: [f, t],
      body: [
        {
          kind: "return",
          value: { kind: "closure", fnName: impl, captures: [f.id, t.id], type, loc },
          loc,
        },
      ],
      loc,
    });
  }
  // The callback evaluates before the receiver, as the call's arguments do.
  const savedFn = lowerer.declareHiddenLocal("%boundFn", type);
  const savedThis = lowerer.declareHiddenLocal("%boundThis", DYN);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: savedFn.id, init: fn, loc },
    { kind: "varDecl", localId: savedThis.id, init: receiverValue(lowerer, receiverNode), loc },
  ];
  const result: IrExpr = {
    kind: "call",
    callee: name as string,
    args: [
      { kind: "varRef", localId: savedFn.id, type, loc },
      { kind: "varRef", localId: savedThis.id, type: DYN, loc },
    ],
    type,
    loc,
  };
  return { kind: "seqExpr", stmts, result, type, loc };
}

/** The receiver as a checked value: records and arrays cross as live
 * references (the callee mutates the caller's object, not a copy). */
function receiverValue(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "dyn") return value;
  if (value.type.kind === "record" || value.type.kind === "array")
    return { kind: "dynFrom", value, type: DYN, liveRef: true, loc: value.loc };
  return lowerer.coerceToExpected(value, DYN);
}
