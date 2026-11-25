import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:crypto's KeyObject is a native checked-dynamic handle (secret keys
 * in scr_lib.c, private and public keys in scr_pki.c), as are Sign and
 * Verify: the types map to dyn, their getters and methods dispatch through
 * the handle, and these helpers lower the uses that a dyn value cannot
 * answer by itself. */

/** Whether `node` names node:crypto's KeyObject class. */
export function isKeyObjectClass(lowerer: Lowerer, node: ts.Expression): boolean {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  return builtin?.module === "crypto" && builtin.member === "KeyObject";
}

/** Whether a value's checker type is node:crypto's KeyObject. */
export function isKeyObjectValue(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  return !!sym && ts.symbolName(sym) === "KeyObject" && lowerer.isStdlibSymbol(sym);
}

/** `v instanceof KeyObject`. */
export function lowerKeyObjectInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isKeyObjectClass(lowerer, expr.right)) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return { kind: "libCall", fn: "crypto.isKeyObject", args: [value], type: BOOL, loc: locOf(expr) };
}

const KEY_OBJECT_METHODS = new Set(["export", "equals", "toCryptoKey"]);
const SIGNER_METHODS = new Set(["update", "sign", "verify"]);

/** Whether a value's checker type is node:crypto's Sign or Verify. */
export function isSignerValue(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  return (
    !!sym &&
    (ts.symbolName(sym) === "Sign" || ts.symbolName(sym) === "Verify") &&
    lowerer.isStdlibSymbol(sym)
  );
}

/** `key.export(...)`, `key.equals(...)` and `key.toCryptoKey(...)`, and
 * the update/sign/verify methods of Sign and Verify (scr_pki.c): the
 * handle answers them as methods, so they dispatch through dynInvoke
 * rather than as a member read and a call. */
export function lowerKeyObjectCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const method = access.name.text;
  const keyMethod = KEY_OBJECT_METHODS.has(method) && isKeyObjectValue(lowerer, access.expression);
  if (!keyMethod && !(SIGNER_METHODS.has(method) && isSignerValue(lowerer, access.expression)))
    return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  if (method === "toCryptoKey") {
    /* WebCrypto owns the conversion, so the call lowers through its unit:
     * the key and the method's arguments travel as one dyn array. */
    const loc = locOf(call);
    const elems = [lowerer.lowerExprExpecting(access.expression, DYN)];
    for (const arg of call.arguments.nodes) elems.push(lowerer.lowerExprExpecting(arg, DYN));
    return {
      kind: "libCall",
      fn: "webcrypto.keyObjectToCryptoKey",
      args: [{ kind: "dynArrLit", elems, type: DYN, loc }],
      type: DYN,
      loc,
    };
  }
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: access.name.text,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc: locOf(call),
  };
}

/** `KeyObject.from(cryptoKey)` on node:crypto's KeyObject class: WebCrypto
 * owns the conversion, so the call lowers through its unit. */
export function lowerKeyObjectFromCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken) return null;
  if (callee.name.text !== "from" || !isKeyObjectClass(lowerer, callee.expression)) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  return {
    kind: "libCall",
    fn: "webcrypto.keyObjectFrom",
    args: [
      {
        kind: "dynArrLit",
        elems: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      },
    ],
    type: DYN,
    loc,
  };
}
