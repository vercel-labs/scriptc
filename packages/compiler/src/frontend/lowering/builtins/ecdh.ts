import * as ts from "../../ts7/adapter.js";
import { dynUndefinedExpr, nodeThrowExpr, varRef } from "../../../ir/build.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { DYN, type IrExpr, type IrStmt } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";
import { v8CalleeText } from "./crypto.js";
import { CRYPTO_CURVES } from "../crypto-tables.js";

/* node:crypto's ECDH is a native checked-dynamic handle (scr_ecdh.c): the
 * ECDH type maps to dyn, its methods dispatch through the handle, and
 * these helpers lower createECDH, the static ECDH.convertKey and the
 * method calls. */

/** Whether `node` names node:crypto's ECDH class. */
function isEcdhClass(lowerer: Lowerer, node: ts.Expression): boolean {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  return builtin?.module === "crypto" && builtin.member === "ECDH";
}

/** Whether a checker type is node:crypto's ECDH. */
export function isEcdhType(lowerer: Lowerer, type: ts.Type): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return !!symbol && ts.symbolName(symbol) === "ECDH" && lowerer.isStdlibSymbol(symbol);
}

/** The call's arguments as checked-dynamic values in hidden locals named
 * `local`, the first `count` of them padded with undefined, so every
 * argument is evaluated left to right before the runtime checks them.
 * Surplus arguments are evaluated and dropped. */
export function dynArguments(
  lowerer: Lowerer,
  call: ts.CallExpression,
  count: number,
  stmts: IrStmt[],
  local = "%ecdhInput",
): IrExpr[] {
  const args = call.arguments.nodes;
  const loc = locOf(call);
  const values: IrExpr[] = [];
  for (let i = 0; i < count; i++) {
    const input: IrExpr = args[i]
      ? lowerer.lowerExprExpecting(args[i]!, DYN)
      : dynUndefinedExpr(loc);
    const saved = lowerer.declareHiddenLocal(local, DYN);
    stmts.push({ kind: "varDecl", localId: saved.id, init: input, loc });
    values.push(varRef(saved.id, DYN, loc));
  }
  for (const arg of args.slice(count))
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc });
  return values;
}

/** The curves scr_ecdh.c implements, by their OpenSSL short names. */
const IMPLEMENTED_CURVES = new Set([
  "prime192v1",
  "secp224r1",
  "prime256v1",
  "secp384r1",
  "secp521r1",
  "secp192k1",
  "secp224k1",
  "secp256k1",
  "brainpoolP256r1",
  "brainpoolP384r1",
  "brainpoolP512r1",
]);

/** A literal curve name that Node knows (crypto.getCurves()) but the
 * runtime does not implement is refused at compile time; computed names
 * throw a coded SC2020 error at run time, and unknown names keep Node's
 * errors. */
function checkCurveName(lowerer: Lowerer, node: ts.Expression | undefined, use: string): void {
  if (node === undefined) return;
  const type = lowerer.typeOf(node);
  if (!type.isStringLiteralType()) return;
  if (IMPLEMENTED_CURVES.has(type.value) || !CRYPTO_CURVES.includes(type.value)) return;
  lowerer.noLowering(
    `${use} with curve '${type.value}'`,
    node,
    "the supported curves are prime192v1, secp224r1, prime256v1, secp384r1, secp521r1, secp192k1, " +
      "secp224k1, secp256k1, brainpoolP256r1, brainpoolP384r1, and brainpoolP512r1",
  );
}

/** crypto.createECDH(curveName): a native ECDH handle. */
export function lowerCreateEcdh(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  if (call.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering("crypto.createECDH with spread arguments", call);
  checkCurveName(lowerer, call.arguments.nodes[0], "crypto.createECDH");
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const values = dynArguments(lowerer, call, 1, stmts);
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn: "crypto.ecdhNew", args: values, type: DYN, loc },
    type: DYN,
    loc,
  };
}

const ECDH_METHODS = new Set([
  "generateKeys",
  "computeSecret",
  "getPublicKey",
  "getPrivateKey",
  "setPrivateKey",
  "setPublicKey",
]);

/** computeSecret(view, encoding): Node reads the second argument as the
 * input encoding, which a view key ignores, so the call answers a Buffer
 * where @types/node declares the string of an output encoding. The
 * form is refused at compile time rather than failing the string check
 * at run time. */
function refuseViewKeyWithEncoding(lowerer: Lowerer, call: ts.CallExpression, name: string): void {
  if (name !== "computeSecret") return;
  const args = call.arguments.nodes;
  if (args.length !== 2) return;
  const encoding = lowerer.typeOf(args[1]!);
  if ((encoding.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0) return;
  if ((lowerer.typeOf(args[0]!).flags & ts.TypeFlags.StringLike) !== 0) return;
  lowerer.noLowering(
    "ECDH.computeSecret(key, encoding) with a Buffer or view key",
    call,
    "Node reads the second argument as the key's input encoding and answers a Buffer; " +
      "pass the output encoding third: computeSecret(key, undefined, encoding)",
  );
}

/** A call whose arguments the checker's chosen @types/node overload does
 * not accept: the checker then types the result by an overload Node may
 * not follow (getPublicKey("HEX") answers a string where the encoding-less
 * overload declares a Buffer), so the call is refused rather than checked
 * against that type at run time. Arguments typed any are accepted. */
export function refuseUnmatchedOverload(
  lowerer: Lowerer,
  call: ts.CallExpression,
  what: string,
): void {
  const signature = lowerer.checker.getResolvedSignature(call);
  if (signature === undefined) return;
  const params = signature.getParameters();
  const args = call.arguments.nodes;
  for (let i = 0; i < args.length && i < params.length; i++) {
    const argType = lowerer.typeOf(args[i]!);
    if ((argType.flags & ts.TypeFlags.Any) !== 0) continue;
    const paramType = lowerer.checker.getTypeOfSymbolAtLocation(params[i]!, call);
    if (lowerer.checker.isTypeAssignableTo(argType, paramType)) continue;
    lowerer.noLowering(
      `${what} with an argument its declared overloads do not accept`,
      args[i]!,
      `pass ${lowerer.checker.typeToString(paramType)} here, as @types/node declares`,
    );
  }
}

/** `ECDH.convertKey(...)` and calls on native ECDH handles. Methods
 * dispatch through the handle with checked-dynamic arguments. */
export function lowerEcdhCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const name = access.name.text;
  if (name === "convertKey" && isEcdhClass(lowerer, access.expression)) {
    if (call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("ECDH.convertKey with spread arguments", call);
    refuseUnmatchedOverload(lowerer, call, "ECDH.convertKey");
    checkCurveName(lowerer, call.arguments.nodes[1], "ECDH.convertKey");
    const loc = locOf(call);
    const stmts: IrStmt[] = [];
    const values = dynArguments(lowerer, call, 5, stmts);
    return {
      kind: "seqExpr",
      stmts,
      result: { kind: "libCall", fn: "crypto.ecdhConvertKey", args: values, type: DYN, loc },
      type: DYN,
      loc,
    };
  }
  if (!isEcdhType(lowerer, lowerer.typeOf(access.expression))) return null;
  const loc = locOf(call);
  if (!ECDH_METHODS.has(name)) {
    // Node reads the member as undefined and throws a TypeError once the
    // receiver and arguments are evaluated.
    const evaluated = [access.expression, ...call.arguments.nodes].map((node): IrStmt => ({
      kind: "exprStmt",
      expr: lowerer.lowerExpr(node),
      loc,
    }));
    return {
      kind: "seqExpr",
      stmts: evaluated,
      result: nodeThrowExpr(1, "", `${v8CalleeText(access)} is not a function`, DYN, loc),
      type: DYN,
      loc,
    };
  }
  if (call.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`ECDH.${name} with spread arguments`, call);
  refuseViewKeyWithEncoding(lowerer, call, name);
  // setPublicKey has no @types/node declaration.
  if (name !== "setPublicKey") refuseUnmatchedOverload(lowerer, call, `ECDH.${name}`);
  const invoke: IrExpr = {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: name,
    calleeName: v8CalleeText(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
  // The arguments match a declared overload, so a Buffer or string result
  // takes its static representation.
  if (name === "setPrivateKey" || name === "setPublicKey") return invoke;
  const result = lowerer.irTypeOf(call);
  return result.kind === "bytes" || result.kind === "string"
    ? lowerer.coerceInto(call, invoke, result)
    : invoke;
}
