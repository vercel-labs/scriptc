import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { BOOL, DYN, type IrExpr, type IrLibFn } from "../../../ir/ir.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import { WEBCRYPTO_DYN_TYPES } from "../../type-mapper.js";
import { isWebCryptoReceiver } from "./crypto.js";

/* WebCrypto (scr_webcrypto.c, with encrypt and decrypt in
 * scr_webcrypto_aes.c and the ECDSA, Ed25519, RSASSA-PKCS1-v1_5 and RSA-PSS
 * algorithms in scr_webcrypto_pki.c): `crypto.subtle`'s `importKey`,
 * `generateKey`, `exportKey`, `encrypt`, `decrypt`, `wrapKey`,
 * `unwrapKey`, `deriveBits`, `deriveKey`, `sign`, `verify` and `digest`
 * called on the crypto global (also through
 * globalThis, node:crypto's webcrypto and node:crypto's subtle) lower to
 * runtime entry points that take the argument vector as one dyn array and
 * answer a promise, so Web IDL conversion, algorithm normalization and
 * every error stay Node-shaped at run time. CryptoKey
 * values are native handles; their type maps to dyn and their members
 * are handle reads. Other SubtleCrypto methods are refused by name. */

const SUBTLE_LOWERED: ReadonlyMap<string, IrLibFn> = new Map([
  ["generateKey", "webcrypto.generateKey"],
  ["importKey", "webcrypto.importKey"],
  ["exportKey", "webcrypto.exportKey"],
  ["encrypt", "webcrypto.encrypt"],
  ["decrypt", "webcrypto.decrypt"],
  ["wrapKey", "webcrypto.wrapKey"],
  ["unwrapKey", "webcrypto.unwrapKey"],
  ["deriveBits", "webcrypto.deriveBits"],
  ["deriveKey", "webcrypto.deriveKey"],
  ["sign", "webcrypto.sign"],
  ["verify", "webcrypto.verify"],
  ["digest", "webcrypto.digest"],
]);

const SUBTLE_HINT =
  "the native WebCrypto surface is crypto.subtle's importKey, generateKey and exportKey for HMAC and AES keys (importKey also for PBKDF2 and HKDF keys), encrypt and decrypt with AES-GCM, AES-CBC or AES-CTR, wrapKey and unwrapKey of secret keys with AES-KW or those ciphers, deriveBits and deriveKey with PBKDF2 or HKDF, sign and verify with HMAC, generateKey, importKey, exportKey, sign and verify for ECDSA, Ed25519, RSASSA-PKCS1-v1_5 and RSA-PSS, and digest with SHA-1, SHA-256, SHA-384 or SHA-512, each called directly on crypto.subtle";

/** Whether `node` is a SubtleCrypto object: `subtle` on a WebCrypto
 * Crypto object (the global, globalThis.crypto or node:crypto's
 * `webcrypto`) or node:crypto's own `subtle` export, named or through
 * the namespace. */
function isSubtleReceiver(lowerer: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) {
    const imported = lowerer.builtinImportOf(node);
    return imported?.module === "crypto" && imported.member === "subtle";
  }
  if (
    !ts.isPropertyAccessExpression(node) ||
    node.questionDotToken ||
    node.name.text !== "subtle"
  ) {
    return false;
  }
  if (stdlibGlobalNameOf(lowerer, node.expression) === "crypto") return true;
  if (isWebCryptoReceiver(lowerer, node.expression)) return true;
  const member = lowerer.builtinMemberOf(node);
  return member?.module === "crypto" && member.member === "subtle";
}

/** `crypto.subtle.<method>(...args)`: the lowered methods become their
 * libCall over the argument vector; every other method is refused. */
export function lowerWebCryptoCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !isSubtleReceiver(lowerer, callee.expression)) {
    return null;
  }
  const member = callee.name.text;
  const fn = SUBTLE_LOWERED.get(member);
  if (fn === undefined) lowerer.noLowering(`crypto.subtle.${member}`, callee, SUBTLE_HINT);
  if (callee.questionDotToken || call.questionDotToken) {
    lowerer.noLowering(`optional calls of crypto.subtle.${member}`, call, SUBTLE_HINT);
  }
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`crypto.subtle.${member} with spread arguments`, call, SUBTLE_HINT);
  }
  const loc = locOf(call);
  const args = call.arguments.nodes.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN),
  );
  return {
    kind: "libCall",
    fn,
    args: [{ kind: "dynArrLit", elems: args, type: DYN, loc }],
    type: { kind: "promise", inner: member === "verify" ? BOOL : DYN },
    loc,
  };
}

/** `v instanceof CryptoKey` against the global. */
export function lowerCryptoKeyInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (stdlibGlobalNameOf(lowerer, expr.right) !== "CryptoKey") return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "webcrypto.isCryptoKey",
    args: [value],
    type: BOOL,
    loc: locOf(expr),
  };
}

/** TypeScript reads of `crypto.subtle` and its members outside a direct
 * call: the global's dynamic object does not carry the lowered methods,
 * so a detached read is refused rather than answering a value without
 * them. JavaScript keeps the dynamic object's reads. */
export function fenceWebCryptoMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  use: "read" | "call",
): IrExpr | null {
  if (use !== "read" || !ts.isPropertyAccessExpression(access)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
  if (isSubtleReceiver(lowerer, access)) {
    lowerer.noLowering("crypto.subtle as a value", access, SUBTLE_HINT);
  }
  if (isSubtleReceiver(lowerer, access.expression)) {
    lowerer.noLowering(`crypto.subtle.${access.name.text} as a value`, access, SUBTLE_HINT);
  }
  return null;
}

/** Whether a checker type is one of the WebCrypto interfaces reached
 * through the crypto global's members (SubtleCrypto, CryptoKey and the
 * algorithm dictionaries). While `crypto` was typed `unknown` those member
 * reads were untyped, so JavaScript destructurings of them keep the
 * module-global path untyped bindings take. `Crypto` itself is excluded:
 * the global was `unknown`, which already mapped to dyn. */
export function isWebCryptoMemberType(lowerer: Lowerer, type: ts.Type): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return (
    symbol !== undefined &&
    ts.symbolName(symbol) !== "Crypto" &&
    WEBCRYPTO_DYN_TYPES.has(ts.symbolName(symbol)) &&
    lowerer.isStdlibSymbol(symbol)
  );
}
