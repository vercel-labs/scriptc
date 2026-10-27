import * as ts from "../../ts7/adapter.js";
import { nodeThrowExpr } from "../../../ir/build.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { DYN, type IrExpr, type IrStmt } from "../../../ir/ir.js";
import { v8CalleeText } from "./crypto.js";
import { dynArguments, refuseUnmatchedOverload } from "./ecdh.js";

/* node:crypto's DiffieHellman and DiffieHellmanGroup are native
 * checked-dynamic handles (scr_dh.c): both types map to dyn, their methods
 * dispatch through the handle, and these helpers lower
 * createDiffieHellman, getDiffieHellman, createDiffieHellmanGroup and the
 * method calls. The runtime applies Node's argument checks, so the
 * constructors take any arguments; method calls are refused when their
 * argument types leave the Buffer or string result undetermined. */

/** Whether a checker type is node:crypto's DiffieHellman class or its
 * DiffieHellmanGroup alias, or a union of them. */
export function isDiffieHellmanType(lowerer: Lowerer, type: ts.Type): boolean {
  if (type.isUnionType())
    return ts.constituentTypes(type).every((part) => isDiffieHellmanType(lowerer, part));
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (!symbol || !lowerer.isStdlibSymbol(symbol)) return false;
  const name = ts.symbolName(symbol);
  return name === "DiffieHellman" || name === "DiffieHellmanGroup";
}

function isDiffieHellmanGroupType(type: ts.Type): boolean {
  if (type.isUnionType()) return ts.constituentTypes(type).some(isDiffieHellmanGroupType);
  const symbol = type.getAliasSymbol();
  return !!symbol && ts.symbolName(symbol) === "DiffieHellmanGroup";
}

function newHandle(
  lowerer: Lowerer,
  call: ts.CallExpression,
  fn: "crypto.dhNew" | "crypto.dhGroupNew",
): IrExpr {
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const values = dynArguments(lowerer, call, fn === "crypto.dhNew" ? 4 : 1, stmts, "%dhInput");
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn, args: values, type: DYN, loc },
    type: DYN,
    loc,
  };
}

/** crypto.createDiffieHellman(sizeOrKey, keyEncoding, generator,
 * generatorEncoding): a native DiffieHellman handle. */
export function lowerCreateDiffieHellman(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  return newHandle(lowerer, call, "crypto.dhNew");
}

/** crypto.getDiffieHellman(groupName) and createDiffieHellmanGroup(name):
 * a native DiffieHellmanGroup handle. */
export function lowerGetDiffieHellman(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  return newHandle(lowerer, call, "crypto.dhGroupNew");
}

const DH_METHODS = new Set([
  "generateKeys",
  "computeSecret",
  "getPrime",
  "getGenerator",
  "getPublicKey",
  "getPrivateKey",
  "setPublicKey",
  "setPrivateKey",
]);

/** Object.prototype methods, which a DiffieHellman inherits. */
const OBJECT_METHODS = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

/** The argument that selects each method's Buffer or string result: the
 * output encoding. */
const OUTPUT_ENCODING_ARG: Record<string, number> = {
  generateKeys: 0,
  computeSecret: 2,
  getPrime: 0,
  getGenerator: 0,
  getPublicKey: 0,
  getPrivateKey: 0,
};

/** An output encoding typed any: the checker's chosen overload then types
 * the result as a Buffer or a string that Node may not answer, so the call
 * is refused rather than checked against that type at run time. */
function refuseAnyOutputEncoding(lowerer: Lowerer, call: ts.CallExpression, name: string): void {
  const index = OUTPUT_ENCODING_ARG[name];
  const arg = index === undefined ? undefined : call.arguments.nodes[index];
  if (!arg || (lowerer.typeOf(arg).flags & ts.TypeFlags.Any) === 0) return;
  lowerer.noLowering(
    `DiffieHellman.${name} with an output encoding typed any`,
    arg,
    "type the encoding as a BinaryToTextEncoding such as 'hex', or as null or undefined for a Buffer",
  );
}

/** Calls on native DiffieHellman and DiffieHellmanGroup handles. Methods
 * dispatch through the handle with checked-dynamic arguments. */
export function lowerDiffieHellmanCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken) return null;
  const receiver = lowerer.typeOf(access.expression);
  if (!isDiffieHellmanType(lowerer, receiver)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const setter = name === "setPublicKey" || name === "setPrivateKey";
  if (!DH_METHODS.has(name) || (setter && isDiffieHellmanGroupType(receiver))) {
    if (OBJECT_METHODS.has(name))
      lowerer.noLowering(
        `DiffieHellman.${name}`,
        call,
        "generateKeys(), computeSecret(), getPrime(), getGenerator(), getPublicKey(), getPrivateKey(), " +
          "setPublicKey(), setPrivateKey() and verifyError are supported",
      );
    // Node reads the member as undefined (a DiffieHellmanGroup has no key
    // setters) and throws a TypeError once the receiver and arguments are
    // evaluated.
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
    lowerer.noLowering(`DiffieHellman.${name} with spread arguments`, call);
  refuseAnyOutputEncoding(lowerer, call, name);
  refuseUnmatchedOverload(lowerer, call, `DiffieHellman.${name}`);
  const invoke: IrExpr = {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: name,
    calleeName: v8CalleeText(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
  // setPublicKey and setPrivateKey answer the receiver where @types/node
  // declares void. Other results take the static representation of the
  // declared overload the arguments match.
  if (setter) return invoke;
  const result = lowerer.irTypeOf(call);
  return result.kind === "bytes" || result.kind === "string"
    ? lowerer.coerceInto(call, invoke, result)
    : invoke;
}
