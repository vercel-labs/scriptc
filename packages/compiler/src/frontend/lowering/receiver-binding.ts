/* A function declaration whose declared `this` is a static type takes it as
 * its first parameter (lower-functions.ts typedThisParameter). Its callers
 * that bind the receiver reach it here: `f.call(receiver, ...)` passes the
 * receiver first (lower-calls.ts), and `forEach(f, thisArg)` calls a closure
 * over the receiver that passes it first (collection-methods.ts). */
import * as ts from "../ts7/syntax.js";
import { type IrExpr, type IrLocal, type IrParam, type IrType } from "../../ir/ir.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { typedThisParameter } from "./lower-functions.js";
import { keyedHelperName } from "./stable-names.js";
import { functionImplementation } from "./symbol-references.js";

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
  const decl = symbol ? functionImplementation(symbol) : null;
  if (!symbol || decl === null) return null;
  const thisType = typedThisParameter(lowerer, decl);
  const sig = lowerer.fnSigsBySymbol.get(symbol);
  if (thisType === null || sig === undefined) return null;
  return { name: sig.name, thisType, params: sig.params.map((p) => p.type), ret: sig.returnType };
}

/** `fn(...)` with a typed `this` bound to `receiverNode`: a closure over the
 * receiver that calls the function directly. */
export function bindTypedReceiver(
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
  const receiver = lowerer.lowerExprExpecting(receiverNode, fn.thisType);
  return { kind: "call", callee: name, args: [receiver], type, loc };
}
