import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  UNDEFINED_T,
  type IrExpr,
  type IrLibFn,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";

/* node:crypto's SPKAC class: crypto.Certificate. Node's instance holds no
 * state — verifySpkac, exportChallenge and exportPublicKey are the same
 * functions on the prototype and the class — so `new Certificate()` lowers
 * to the empty record (type-mapper.ts and lower-classes.ts) and each call
 * lowers to one libCall over its spkac argument: the base64 text decodes
 * as NETSCAPE_SPKI_b64_decode does, and the answer is Node's Buffer or
 * boolean (scr_pki.c). A named import (`import { Certificate }`) and the
 * namespace spelling both answer the class; an instance-typed receiver
 * evaluates for its side effects, as Node's call does. */

type CertificateMethod = { fn: IrLibFn; min: number; max: number; form: string };

const METHODS: ReadonlyMap<string, CertificateMethod> = new Map<string, CertificateMethod>([
  [
    "verifySpkac",
    { fn: "crypto.spkacVerify", min: 1, max: 2, form: "verifySpkac(spkac[, encoding])" },
  ],
  [
    "exportChallenge",
    { fn: "crypto.spkacChallenge", min: 1, max: 2, form: "exportChallenge(spkac[, encoding])" },
  ],
  [
    "exportPublicKey",
    { fn: "crypto.spkacPublicKey", min: 1, max: 2, form: "exportPublicKey(spkac[, encoding])" },
  ],
]);

const dynUndefined = (loc: SrcLoc): IrExpr => ({
  kind: "dynFrom",
  value: { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
  type: DYN,
  loc,
});

/** Whether `node` is the Certificate class value: `crypto.Certificate`
 * through the namespace, or a naming binding (`import { Certificate }`,
 * the destructured require twin). */
function isCertificateClassValue(lowerer: Lowerer, node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "Certificate")
    return lowerer.builtinNamespaceModuleOf(node.expression) === "crypto";
  if (ts.isIdentifier(node)) {
    const bi = lowerer.builtinImportOf(node);
    return bi?.module === "crypto" && bi.member === "Certificate";
  }
  return false;
}

/** Whether `node` is typed as a Certificate instance (the class's symbol
 * in the stdlib declarations). */
function isCertificateRecord(lowerer: Lowerer, node: ts.Expression): boolean {
  const sym = lowerer.typeOf(node).getSymbol();
  return sym !== undefined && ts.symbolName(sym) === "Certificate" && lowerer.isStdlibSymbol(sym);
}

/** Whether `node` is the `new Certificate()` expression, whose evaluation
 * has no side effect to keep. */
function isCertificateNew(lowerer: Lowerer, node: ts.Expression): boolean {
  return ts.isNewExpression(node) && isCertificateClassValue(lowerer, node.expression);
}

/** The Certificate methods, static or on an instance. */
export function lowerCertificateCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const method = METHODS.get(access.name.text);
  if (!method) return null;
  const recv = access.expression;
  const isStatic = isCertificateClassValue(lowerer, recv);
  if (!isStatic && !isCertificateRecord(lowerer, recv)) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (args.length < method.min || args.length > method.max || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `Certificate.${access.name.text} with ${args.length} argument(s)`,
      call,
      `the supported form is ${method.form}`,
    );
  }
  const spkac = lowerer.lowerExprExpecting(args[0]!, DYN);
  const encoding = args.length > 1 ? lowerer.lowerExprExpecting(args[1]!, DYN) : dynUndefined(loc);
  const type: IrType = method.fn === "crypto.spkacVerify" ? BOOL : BYTES_U8;
  const value: IrExpr = { kind: "libCall", fn: method.fn, args: [spkac, encoding], type, loc };
  // A static receiver is a compile-time value; an instance receiver
  // evaluates, as Node's method call does, and its record is otherwise
  // unused.
  if (isStatic || ts.isIdentifier(recv) || isCertificateNew(lowerer, recv)) return value;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(recv), loc }],
    result: value,
    type,
    loc,
  };
}
