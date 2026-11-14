import { lowerBuiltinByteInput, errorFirstBytesCallback, errorFirstCallback } from "./arguments.js";
import { isKeyObjectValue } from "./key-object.js";
import { voidizedCallback } from "../lower-server.js";
import { lowerCreateEcdh } from "./ecdh.js";
import { lowerCreateDiffieHellman, lowerGetDiffieHellman } from "./dh.js";
import { boolLit, dynUndefinedExpr, nodeThrowExpr, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { locOf } from "../../program.js";
import { CIPHER_TYPE_NAMES } from "../../type-mapper.js";
import { CRYPTO_CIPHERS, CRYPTO_CURVES, CRYPTO_HASHES, CRYPTO_MACS } from "../crypto-tables.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import {
  BOOL,
  BYTES_U8,
  CRYPTOHASH_T,
  CRYPTOHMAC_T,
  DYN,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrType,
  type IrStmt,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  funcOf,
} from "../../../ir/ir.js";

/** The composed crypto pattern: `randomBytes(n).toString(enc)` lowers
 * as ONE string-producing libCall — the Buffer between the two calls
 * never exists at runtime. Only literal "hex"/"base64" encodings lower
 * (the runtime implements exactly those); wider forms fall through to
 * the ordinary Buffer lowering. Null when this is not a toString on a
 * crypto.randomBytes call. */
export function lowerCryptoComposedCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (access.name.text === "digest") return lowerHashDigestChain(lowerer, call, access);
  if (access.name.text !== "toString") return null;
  const recv = access.expression;
  if (!ts.isCallExpression(recv) || recv.questionDotToken) return null;
  if (!ts.isIdentifier(recv.expression)) return null;
  const bi = lowerer.builtinImportOf(recv.expression);
  if (!bi || bi.module !== "crypto" || bi.member !== "randomBytes") return null;
  const loc = locOf(call);
  // Only the exact composed shape fuses — one size argument, one literal
  // "hex"/"base64" encoding. Anything else falls through (null): bare
  // randomBytes lowers to a real Buffer through the crypto table, and
  // the .toString rides the ordinary Buffer method lowering.
  if (recv.arguments.nodes.length !== 1) return null;
  const encNode = call.arguments.nodes[0];
  const encT = encNode ? lowerer.typeOf(encNode) : undefined;
  if (
    call.arguments.nodes.length !== 1 ||
    !encT?.isStringLiteralType() ||
    (encT.value !== "hex" && encT.value !== "base64")
  ) {
    return null;
  }
  const size = lowerer.lowerExprExpecting(recv.arguments.nodes[0]!, F64);
  const enc = lowerer.lowerExprExpecting(encNode!, STRING);
  return {
    kind: "libCall",
    fn: "crypto.randomBytesToString",
    args: [size, enc],
    type: STRING,
    loc,
  };
}

/** Fast path for the exact single-update hash chain. Wider algorithms,
 * stored handles, multiple updates, Buffer digests, and input encodings
 * fall through to the first-class Hash lowering below. */
function lowerHashDigestChain(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const updateCall = access.expression;
  if (!ts.isCallExpression(updateCall) || updateCall.questionDotToken) return null;
  const updAccess = updateCall.expression;
  if (
    !ts.isPropertyAccessExpression(updAccess) ||
    updAccess.questionDotToken ||
    updAccess.name.text !== "update"
  ) {
    return null;
  }
  const chCall = updAccess.expression;
  if (!ts.isCallExpression(chCall) || chCall.questionDotToken) return null;
  const callee = chCall.expression;
  const bi = ts.isIdentifier(callee)
    ? lowerer.builtinImportOf(callee)
    : ts.isPropertyAccessExpression(callee)
      ? lowerer.builtinMemberOf(callee)
      : null;
  if (!bi || bi.module !== "crypto" || bi.member !== "createHash") return null;
  const loc = locOf(call);
  const algT =
    chCall.arguments.nodes.length === 1 ? lowerer.typeOf(chCall.arguments.nodes[0]!) : undefined;
  if (!algT?.isStringLiteralType() || (algT.value !== "sha256" && algT.value !== "sha1"))
    return null;
  if (updateCall.arguments.nodes.length !== 1) {
    return null;
  }
  const encT =
    call.arguments.nodes.length === 1 ? lowerer.typeOf(call.arguments.nodes[0]!) : undefined;
  if (!encT?.isStringLiteralType() || (encT.value !== "hex" && encT.value !== "base64")) {
    return null;
  }
  // alg and enc are proven literals (fenced above), so lowering them
  // out of source position observes nothing; the data lowers between
  // them in its own source order.
  const alg = lowerer.lowerExprExpecting(chCall.arguments.nodes[0]!, STRING);
  // The data picks the runtime entry by its static type, the
  // fileURLToPath convention: strings hash their UTF-8 bytes (Node's
  // default input encoding), Buffers/typed arrays hash their bytes.
  const dataNode = updateCall.arguments.nodes[0]!;
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
  if (dataIr?.kind === "bytes") {
    const data = cryptoByteView(lowerer, dataNode, lowerer.lowerExpr(dataNode));
    const enc = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
    return {
      kind: "libCall",
      fn: "crypto.hashDigestBytes",
      args: [alg, data, enc],
      type: STRING,
      loc,
    };
  }
  if (dataIr?.kind === "string") {
    const data = lowerer.lowerExprExpecting(dataNode, STRING);
    const enc = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
    return {
      kind: "libCall",
      fn: "crypto.hashDigestStr",
      args: [alg, data, enc],
      type: STRING,
      loc,
    };
  }
  return null;
}

/** Node's normalizeEncoding(): the canonical name of a Buffer encoding,
 * compared case-insensitively, or undefined for a name Node does not know. */
function cryptoEncodingName(value: string): string | undefined {
  switch (value.toLowerCase()) {
    case "hex":
      return "hex";
    case "base64":
      return "base64";
    case "base64url":
      return "base64url";
    case "":
    case "utf8":
    case "utf-8":
      return "utf8";
    case "latin1":
    case "binary":
      return "latin1";
    case "ascii":
      return "ascii";
    case "utf16le":
    case "utf-16le":
    case "ucs2":
    case "ucs-2":
      return "utf16le";
    default:
      return undefined;
  }
}

/** The values of a string literal type or a union of them; undefined when
 * the type allows other values. */
function stringLiteralValues(type: ts.Type): string[] | undefined {
  if (type.isStringLiteralType()) return [type.value];
  if (!type.isUnionType()) return undefined;
  const values: string[] = [];
  for (const member of ts.constituentTypes(type)) {
    if (!member.isStringLiteralType()) return undefined;
    values.push(member.value);
  }
  return values;
}

/** Whether every value the node's type allows is an encoding that gives a
 * string digest: a Buffer encoding Node knows. Hash.digest() treats ""
 * as no encoding and returns a Buffer; crypto.hash() reads it as UTF-8. */
function isStringDigestEncoding(
  lowerer: Lowerer,
  node: ts.Expression,
  emptyIsString: boolean,
): boolean {
  const values = stringLiteralValues(lowerer.typeOf(node));
  return (
    !!values &&
    values.every(
      (value) => (value !== "" || emptyIsString) && cryptoEncodingName(value) !== undefined,
    )
  );
}

/** Whether every offset/size argument is statically a number; other
 * values take the runtime checks, which throw Node's errors or apply its
 * defaults. */
function cryptoNumberArgs(lowerer: Lowerer, nodes: readonly ts.Expression[]): boolean {
  return nodes.every((node) => lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "f64");
}

/** Whether a value of this type could be a function at run time: a
 * function type, a checked-dynamic value (any/unknown), or a union with
 * one of those arms. A call whose callback position cannot be a function
 * never schedules anything, so it takes the synchronous entry point. */
function typeHoldsFunction(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (!type) return true;
  const holds = (t: IrType): boolean => {
    if (t.kind === "func" || t.kind === "dyn") return true;
    if (t.kind === "union")
      return (lowerer.unions.get(t.unionId)?.arms ?? []).some((arm) => holds(arm));
    return false;
  };
  return holds(type);
}

/** A view's bytes as the Uint8Array the byte-input libCalls take: other
 * TypedArrays and DataViews become a u8 view of the same memory. */
function cryptoByteView(lowerer: Lowerer, node: ts.Expression, value: IrExpr): IrExpr {
  if (value.type.kind !== "bytes" || value.type.elem === "u8") return value;
  return {
    kind: "libCall",
    fn: "bytes.bufferSource",
    args: [lowerer.coerceInto(node, value, DYN)],
    type: BYTES_U8,
    loc: locOf(node),
  };
}

function dynArg(lowerer: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  return node ? lowerer.lowerExprExpecting(node, DYN) : dynUndefinedExpr(loc);
}

/** Node evaluates a surplus argument for its side effects, then drops it.
 * Null when there is nothing to evaluate: a `undefined` or `null` literal
 * has no side effect and no representable value to hold. */
function dropArg(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrStmt | null {
  const value = lowerer.lowerExpr(node);
  // A call that throws (a `never` value) has no value to hold.
  if (value.type.kind === "void") return { kind: "exprStmt", expr: value, loc };
  // A literal `undefined` or `null` has no side effect to keep; a call
  // that only *answers* one still evaluates (and may throw).
  if (value.kind === "unitLit") return null;
  if (value.type.kind === "undefinedT" || value.type.kind === "nullT")
    return { kind: "exprStmt", expr: value, loc };
  const dropped = lowerer.declareHiddenLocal("%cryptoDropped", value.type);
  return { kind: "varDecl", localId: dropped.id, init: value, loc };
}

/** Node's argument evaluation for a call whose arguments do not fit the
 * typed signature: the first `count` arguments evaluate left to right into
 * checked-dynamic hidden locals (missing ones read as undefined), and any
 * surplus arguments evaluate after them and are dropped. */
function dynCallArgs(
  lowerer: Lowerer,
  call: ts.CallExpression,
  count: number,
): { stmts: IrStmt[]; args: IrExpr[] } {
  const loc = locOf(call);
  const nodes = call.arguments.nodes;
  const stmts: IrStmt[] = [];
  const args: IrExpr[] = [];
  for (let i = 0; i < Math.max(count, nodes.length); i++) {
    const node = nodes[i];
    if (i >= count) {
      const dropped = dropArg(lowerer, node!, loc);
      if (dropped) stmts.push(dropped);
      continue;
    }
    const value = node ? lowerer.lowerExprExpecting(node, DYN) : dynUndefinedExpr(loc);
    const saved = lowerer.declareHiddenLocal("%cryptoArg", DYN);
    stmts.push({ kind: "varDecl", localId: saved.id, init: value, loc });
    args.push(varRef(saved.id, DYN, loc));
  }
  return { stmts, args };
}

/** A crypto entry called with Node's own argument checks: every argument
 * evaluates in source order, and the entry throws Node's error for a shape
 * the typed signature does not describe. */
function dynCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  count: number,
  fn: IrLibFn,
  type: IrType,
): IrExpr {
  const loc = locOf(call);
  const { stmts, args } = dynCallArgs(lowerer, call, count);
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn, args, type, loc },
    type,
    loc,
  };
}

/** A Hash/Hmac method call with Node's argument checks: the receiver and
 * the arguments evaluate left to right, surplus arguments are dropped, and
 * `fn` receives the receiver followed by the first `count` arguments. */
function dynHashCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  receiverType: IrType,
  count: number,
  fn: IrLibFn,
  type: IrType,
): IrExpr {
  const loc = locOf(call);
  const stmts: IrStmt[] = [];
  const target = lowerer.declareHiddenLocal("%cryptoRecv", receiverType);
  stmts.push({
    kind: "varDecl",
    localId: target.id,
    init: lowerer.lowerExprExpecting(access.expression, receiverType),
    loc,
  });
  const nodes = call.arguments.nodes;
  const args: IrExpr[] = [varRef(target.id, receiverType, loc)];
  for (let i = 0; i < Math.max(count, nodes.length); i++) {
    const node = nodes[i];
    if (i >= count) {
      const dropped = dropArg(lowerer, node!, loc);
      if (dropped) stmts.push(dropped);
      continue;
    }
    const value = node ? lowerer.lowerExprExpecting(node, DYN) : dynUndefinedExpr(loc);
    const saved = lowerer.declareHiddenLocal("%cryptoArg", DYN);
    stmts.push({ kind: "varDecl", localId: saved.id, init: value, loc });
    args.push(varRef(saved.id, DYN, loc));
  }
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn, args, type, loc },
    type,
    loc,
  };
}

/** Whether an argument's static type is one the typed byte-input lowering
 * describes without a refusal. */
function isByteInputType(lowerer: Lowerer, node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const type = lowerer.mapTypeOf(lowerer.typeOf(node));
  return type?.kind === "string" || type?.kind === "bytes";
}

/** A digest name. The runtime resolves every name and alias Node 24
 * accepts and throws Node's error for the others, so literals are not
 * checked here. */
function cryptoAlgorithm(lowerer: Lowerer, node: ts.Expression): IrExpr {
  return lowerer.lowerExprExpecting(node, STRING);
}

function cryptoKdfInput(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const loc = locOf(node);
  const type = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (type?.kind === "string" || (type?.kind === "bytes" && type.elem === "u8"))
    return lowerBuiltinByteInput(lowerer, node, loc, "crypto");
  const symbol = lowerer.typeOf(node).getSymbol();
  if (
    type?.kind === "bytes" ||
    (symbol !== undefined &&
      ts.symbolName(symbol) === "ArrayBuffer" &&
      lowerer.isStdlibSymbol(symbol))
  ) {
    const value = lowerer.coerceInto(node, lowerer.lowerExpr(node), DYN);
    return { kind: "libCall", fn: "bytes.bufferSource", args: [value], type: BYTES_U8, loc };
  }
  lowerer.noLowering(
    "crypto key derivation with this input",
    node,
    "strings, Buffers, numeric typed arrays, DataViews, and fixed-length ArrayBuffers are supported; KeyObjects are accepted only as hkdf's key, as in Node",
  );
}

export function lowerCryptoModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "crypto") return null;
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`crypto.${bi.member} with spread arguments`, expr);
  }
  if (bi.member === "getRandomValues") return lowerCryptoGetRandomValues(lowerer, expr);
  if (bi.member === "randomBytes") {
    const callbackType =
      args.length === 2 ? lowerer.mapTypeOf(lowerer.typeOf(args[1]!)) : undefined;
    // A missing or surplus argument, a size of another type, and a callback
    // that does not fit (error, buffer) take Node's checks at run time; an
    // explicit `undefined` callback selects the synchronous result. A
    // callback position that cannot hold a function never schedules one,
    // so it takes the same checks through the synchronous entry.
    if (
      args.length < 1 ||
      args.length > 2 ||
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "f64" ||
      (args.length === 2 && (callbackType?.kind !== "func" || callbackType.params.length > 2))
    ) {
      return dynCall(
        lowerer,
        expr,
        2,
        args.length >= 2 && typeHoldsFunction(lowerer, args[1]!)
          ? "crypto.randomBytesAnyCb"
          : "crypto.randomBytesAny",
        DYN,
      );
    }
    if (args.length === 1) return null;
    return {
      kind: "libCall",
      fn: "crypto.randomBytesCb",
      args: [
        lowerer.lowerExprExpecting(args[0]!, F64),
        errorFirstBytesCallback(lowerer, args[1]!, "crypto"),
      ],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "pbkdf2") {
    const callbackType =
      args.length === 6 ? lowerer.mapTypeOf(lowerer.typeOf(args[5]!)) : undefined;
    // A missing or surplus argument, a value of another type, and a
    // callback that does not fit (error, buffer) take Node's checks at run
    // time, including the five-argument form whose digest is the callback.
    if (
      args.length !== 6 ||
      args.some(ts.isSpreadElement) ||
      !isByteInputType(lowerer, args[0]) ||
      !isByteInputType(lowerer, args[1]) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[2]!))?.kind !== "f64" ||
      lowerer.mapTypeOf(lowerer.typeOf(args[3]!))?.kind !== "f64" ||
      lowerer.mapTypeOf(lowerer.typeOf(args[4]!))?.kind !== "string" ||
      callbackType?.kind !== "func" ||
      callbackType.params.length > 2
    ) {
      return dynCall(lowerer, expr, 6, "crypto.pbkdf2AnyCb", VOID);
    }
    return {
      kind: "libCall",
      fn: "crypto.pbkdf2Cb",
      args: [
        lowerBuiltinByteInput(lowerer, args[0]!, locOf(args[0]!), "crypto"),
        lowerBuiltinByteInput(lowerer, args[1]!, locOf(args[1]!), "crypto"),
        lowerer.lowerExprExpecting(args[2]!, F64),
        lowerer.lowerExprExpecting(args[3]!, F64),
        cryptoAlgorithm(lowerer, args[4]!),
        errorFirstBytesCallback(lowerer, args[5]!, "crypto"),
      ],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "hkdf" || bi.member === "hkdfSync") {
    const async = bi.member === "hkdf";
    const expected = async ? 6 : 5;
    const callbackType =
      async && args.length === expected ? lowerer.mapTypeOf(lowerer.typeOf(args[5]!)) : undefined;
    // A missing or surplus argument and a value of another type take Node's
    // checks at run time, in its order; the derivation's result or failure
    // reaches a callback in a later macrotask.
    if (
      args.length !== expected ||
      args.some(ts.isSpreadElement) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "string" ||
      !(isKeyObjectValue(lowerer, args[1]!) || isByteInputType(lowerer, args[1])) ||
      !isByteInputType(lowerer, args[2]) ||
      !isByteInputType(lowerer, args[3]) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[4]!))?.kind !== "f64" ||
      (async && (callbackType?.kind !== "func" || callbackType.params.length > 2))
    ) {
      return dynCall(
        lowerer,
        expr,
        expected,
        async ? "crypto.hkdfAnyCb" : "crypto.hkdfAny",
        async ? VOID : DYN,
      );
    }
    const values = [
      cryptoAlgorithm(lowerer, args[0]!),
      isKeyObjectValue(lowerer, args[1]!)
        ? ({
            kind: "libCall",
            fn: "crypto.keyObjectInput",
            args: [lowerer.lowerExprExpecting(args[1]!, DYN)],
            type: BYTES_U8,
            loc,
          } satisfies IrExpr)
        : cryptoKdfInput(lowerer, args[1]!),
      cryptoKdfInput(lowerer, args[2]!),
      cryptoKdfInput(lowerer, args[3]!),
      lowerer.lowerExprExpecting(args[4]!, F64),
    ];
    if (async) values.push(errorFirstBytesCallback(lowerer, args[5]!, "crypto.hkdf", true));
    return {
      kind: "libCall",
      fn: async ? "crypto.hkdfCb" : "crypto.hkdf",
      args: values,
      type: async ? VOID : DYN,
      loc,
    };
  }
  if (bi.member === "scrypt" || bi.member === "scryptSync") {
    const async = bi.member === "scrypt";
    const minimum = async ? 4 : 3;
    // The callback is the last argument: the options position when no
    // options are passed (scrypt(password, salt, keylen, callback)), and
    // the fifth argument otherwise.
    const callbackType =
      async && args.length >= minimum
        ? lowerer.mapTypeOf(lowerer.typeOf(args[args.length - 1]!))
        : undefined;
    // A missing or surplus argument and a value of another type take Node's
    // checks at run time, in its order: password, salt, keylen, options,
    // then the callback (a four-argument call whose fourth value is a
    // function passes it as the callback).
    if (
      args.length < minimum ||
      args.length > minimum + 1 ||
      args.some(ts.isSpreadElement) ||
      !isByteInputType(lowerer, args[0]) ||
      !isByteInputType(lowerer, args[1]) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[2]!))?.kind !== "f64" ||
      (async && (callbackType?.kind !== "func" || callbackType.params.length > 2))
    ) {
      return dynCall(
        lowerer,
        expr,
        async ? 5 : 4,
        async ? "crypto.scryptAnyCb" : "crypto.scryptAny",
        async ? VOID : BYTES_U8,
      );
    }
    const values = [
      cryptoKdfInput(lowerer, args[0]!),
      cryptoKdfInput(lowerer, args[1]!),
      lowerer.lowerExprExpecting(args[2]!, F64),
    ];
    const options = args.length > minimum ? args[3]! : undefined;
    values.push(
      options
        ? lowerer.coerceInto(options, lowerer.lowerExpr(options), DYN)
        : dynUndefinedExpr(loc),
    );
    if (async)
      values.push(errorFirstBytesCallback(lowerer, args[args.length - 1]!, "crypto.scrypt"));
    return {
      kind: "libCall",
      fn: async ? "crypto.scryptCb" : "crypto.scrypt",
      args: values,
      type: async ? VOID : BYTES_U8,
      loc,
    };
  }
  if (bi.member === "createHash") {
    // A missing, surplus or non-string algorithm takes Node's validateString
    // check at run time.
    if (
      args.length < 1 ||
      args.length > 2 ||
      args.some(ts.isSpreadElement) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "string"
    ) {
      return dynCall(lowerer, expr, 2, "crypto.hashNewAny", CRYPTOHASH_T);
    }
    const algorithm = cryptoAlgorithm(lowerer, args[0]!);
    if (args.length === 1) {
      return { kind: "libCall", fn: "crypto.hashNew", args: [algorithm], type: CRYPTOHASH_T, loc };
    }
    return {
      kind: "libCall",
      fn: "crypto.hashNewOpts",
      args: [algorithm, lowerer.lowerExprExpecting(args[1]!, DYN)],
      type: CRYPTOHASH_T,
      loc,
    };
  }
  if (bi.member === "createCipheriv" || bi.member === "createDecipheriv") {
    const algorithm = args[0];
    if (algorithm) checkCipherName(lowerer, algorithm, `crypto.${bi.member}`);
    const stmts: IrStmt[] = [];
    const values: IrExpr[] = [boolLit(bi.member === "createDecipheriv", loc)];
    // Every argument is evaluated, left to right, before the runtime
    // checks them; surplus arguments are evaluated and dropped.
    for (let i = 0; i < 4; i++) {
      const input: IrExpr = args[i]
        ? lowerer.lowerExprExpecting(args[i]!, DYN)
        : dynUndefinedExpr(loc);
      const saved = lowerer.declareHiddenLocal("%cipherInput", DYN);
      stmts.push({ kind: "varDecl", localId: saved.id, init: input, loc });
      values.push(varRef(saved.id, DYN, loc));
    }
    for (const arg of args.slice(4))
      stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc });
    return {
      kind: "seqExpr",
      stmts,
      result: { kind: "libCall", fn: "crypto.cipherNew", args: values, type: DYN, loc },
      type: DYN,
      loc,
    };
  }
  if (bi.member === "createECDH") return lowerCreateEcdh(lowerer, expr);
  if (bi.member === "createDiffieHellman") return lowerCreateDiffieHellman(lowerer, expr);
  if (bi.member === "getDiffieHellman" || bi.member === "createDiffieHellmanGroup")
    return lowerGetDiffieHellman(lowerer, expr);
  if (bi.member === "createHmac") {
    // A missing, surplus or non-string algorithm takes Node's check at run
    // time, which names the argument "hmac".
    if (
      args.length < 1 ||
      args.length > 3 ||
      args.some(ts.isSpreadElement) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "string"
    ) {
      return dynCall(lowerer, expr, 3, "crypto.hmacNewAny", CRYPTOHMAC_T);
    }
    const algorithm = cryptoAlgorithm(lowerer, args[0]!);
    if (args.length === 1) {
      // A missing key reads as undefined: Node's prepareSecretKey throws
      // ERR_INVALID_ARG_TYPE.
      return {
        kind: "libCall",
        fn: "crypto.hmacNewDyn",
        args: [algorithm, dynUndefinedExpr(loc), dynUndefinedExpr(loc)],
        type: CRYPTOHMAC_T,
        loc,
      };
    }
    const key = lowerer.lowerExpr(args[1]!);
    if (args.length === 3 || (key.type.kind !== "string" && key.type.kind !== "bytes")) {
      // Views, ArrayBuffers, options.encoding and values of other types
      // take Node's prepareSecretKey checks at run time.
      return {
        kind: "libCall",
        fn: "crypto.hmacNewDyn",
        args: [algorithm, lowerer.coerceInto(args[1]!, key, DYN), dynArg(lowerer, args[2], loc)],
        type: CRYPTOHMAC_T,
        loc,
      };
    }
    if (key.type.kind === "string") {
      return {
        kind: "libCall",
        fn: "crypto.hmacNewStr",
        args: [algorithm, key],
        type: CRYPTOHMAC_T,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "crypto.hmacNewBytes",
      args: [algorithm, cryptoByteView(lowerer, args[1]!, key)],
      type: CRYPTOHMAC_T,
      loc,
    };
  }
  if (bi.member === "createMac") {
    if (args.length < 1 || args.length > 3 || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `crypto.createMac with ${args.length} arguments`,
        expr,
        "createMac(algorithm, key[, options]) is supported",
      );
    }
    // Every argument goes through Node's normalizeKey and options checks
    // at run time; a missing key reads as undefined, like createHmac's.
    return {
      kind: "libCall",
      fn: "crypto.macNewDyn",
      args: [
        lowerer.lowerExprExpecting(args[0]!, DYN),
        args[1] ? lowerer.lowerExprExpecting(args[1]!, DYN) : dynUndefinedExpr(loc),
        args[2] ? lowerer.lowerExprExpecting(args[2]!, DYN) : dynUndefinedExpr(loc),
      ],
      type: DYN,
      loc,
    };
  }
  if (bi.member === "hash") {
    // A missing, surplus or non-string algorithm takes Node's checks at
    // run time, in its order: algorithm, input, then options.
    if (
      args.length < 2 ||
      args.length > 3 ||
      args.some(ts.isSpreadElement) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "string"
    ) {
      return dynCall(lowerer, expr, 3, "crypto.hashOneshotAny", DYN);
    }
    const algorithm = cryptoAlgorithm(lowerer, args[0]!);
    const data = lowerer.lowerExpr(args[1]!);
    let options = args[2];
    // An options literal holding only a literal string-digest
    // outputEncoding is that encoding; evaluating it observes nothing.
    if (options && ts.isObjectLiteralExpression(options) && options.properties.nodes.length === 1) {
      const property = options.properties.nodes[0]!;
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "outputEncoding" &&
        ts.isStringLiteral(property.initializer) &&
        isStringDigestEncoding(lowerer, property.initializer, true)
      ) {
        options = property.initializer;
      }
    }
    // String data or a view with no options or a string-digest encoding
    // has a string result; every other form takes Node's checks at run
    // time and returns the string or Buffer it produces.
    if (
      (data.type.kind === "string" || data.type.kind === "bytes") &&
      (options === undefined || isStringDigestEncoding(lowerer, options, true))
    ) {
      const encoding: IrExpr = options
        ? lowerer.lowerExprExpecting(options, STRING)
        : { kind: "strLit", value: "hex", type: STRING, loc };
      return {
        kind: "libCall",
        fn: data.type.kind === "string" ? "crypto.hashDigestStr" : "crypto.hashDigestBytes",
        args: [algorithm, cryptoByteView(lowerer, args[1]!, data), encoding],
        type: STRING,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "crypto.hashOneshot",
      args: [algorithm, lowerer.coerceInto(args[1]!, data, DYN), dynArg(lowerer, options, loc)],
      type: DYN,
      loc,
    };
  }
  if (bi.member === "timingSafeEqual") {
    if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement))
      lowerer.noLowering(`crypto.timingSafeEqual with ${args.length} arguments`, expr);
    const left = lowerer.lowerExpr(args[0]!);
    const right = args[1] ? lowerer.lowerExpr(args[1]) : undefined;
    // Views of every element kind compare their bytes; ArrayBuffers and
    // other values take Node's checks at run time.
    if (left.type.kind === "bytes" && right?.type.kind === "bytes") {
      return {
        kind: "libCall",
        fn: "crypto.timingSafeEqual",
        args: [left, right],
        type: BOOL,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "crypto.timingSafeEqualDyn",
      args: [
        lowerer.coerceInto(args[0]!, left, DYN),
        right ? lowerer.coerceInto(args[1]!, right, DYN) : dynUndefinedExpr(loc),
      ],
      type: BOOL,
      loc,
    };
  }
  if (bi.member === "randomFillSync") {
    if (args.length < 1 || args.length > 3 || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `crypto.randomFillSync with ${args.length} arguments`,
        expr,
        "randomFillSync(buffer[, offset[, size]]) is supported",
      );
    }
    const buffer = lowerer.lowerExpr(args[0]!);
    if (buffer.type.kind === "bytes" && cryptoNumberArgs(lowerer, args.slice(1))) {
      // A view returns itself, at its own type.
      const offset = args[1]
        ? lowerer.lowerExprExpecting(args[1]!, F64)
        : ({ kind: "numLit", value: 0, type: F64, loc } satisfies IrExpr);
      if (args[2]) {
        return {
          kind: "libCall",
          fn: "crypto.randomFillView",
          args: [buffer, offset, lowerer.lowerExprExpecting(args[2]!, F64)],
          type: buffer.type,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "crypto.randomFillViewRest",
        args: [buffer, offset],
        type: buffer.type,
        loc,
      };
    }
    // ArrayBuffers and other values take Node's checks at run time.
    return {
      kind: "libCall",
      fn: "crypto.randomFillSyncDyn",
      args: [
        lowerer.coerceInto(args[0]!, buffer, DYN),
        dynArg(lowerer, args[1], loc),
        dynArg(lowerer, args[2], loc),
      ],
      type: DYN,
      loc,
    };
  }
  if (bi.member === "randomFill") {
    if (args.length < 2 || args.length > 4 || args.some(ts.isSpreadElement)) {
      lowerer.noLowering(
        `crypto.randomFill with ${args.length} arguments`,
        expr,
        "randomFill(buffer[, offset[, size]], callback) is supported",
      );
    }
    const form: IrExpr = { kind: "numLit", value: args.length - 1, type: F64, loc };
    const buffer = lowerer.lowerExpr(args[0]!);
    if (buffer.type.kind === "bytes" && cryptoNumberArgs(lowerer, args.slice(1, -1))) {
      const view = buffer.type;
      const offset =
        args.length >= 3
          ? lowerer.lowerExprExpecting(args[1]!, F64)
          : ({ kind: "numLit", value: 0, type: F64, loc } satisfies IrExpr);
      const size =
        args.length === 4
          ? lowerer.lowerExprExpecting(args[2]!, F64)
          : ({ kind: "numLit", value: 0, type: F64, loc } satisfies IrExpr);
      const callback = errorFirstCallback(
        lowerer,
        args[args.length - 1]!,
        "crypto.randomFill",
        (value) => value.kind === "bytes" && value.elem === view.elem,
        "the buffer's own view",
      );
      return {
        kind: "libCall",
        fn: "crypto.randomFillCb",
        args: [buffer, offset, size, form, callback],
        type: VOID,
        loc,
      };
    }
    const callback = errorFirstCallback(
      lowerer,
      args[args.length - 1]!,
      "crypto.randomFill",
      () => false,
      "unknown-typed",
    );
    return {
      kind: "libCall",
      fn: "crypto.randomFillCbDyn",
      args: [
        lowerer.coerceInto(args[0]!, buffer, DYN),
        args.length >= 3 ? lowerer.lowerExprExpecting(args[1]!, DYN) : dynUndefinedExpr(loc),
        args.length === 4 ? lowerer.lowerExprExpecting(args[2]!, DYN) : dynUndefinedExpr(loc),
        form,
        callback,
      ],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "randomInt") {
    const last = args[args.length - 1];
    const lastType = last ? (lowerer.mapTypeOf(lowerer.typeOf(last)) ?? undefined) : undefined;
    const withCallback = args.length === 3 || (args.length === 2 && lastType?.kind === "func");
    const numbers = withCallback ? args.slice(0, -1) : args;
    // A missing or surplus argument, a number of another type, and a
    // callback position that is neither a function nor absent take Node's
    // checks at run time.
    const extra = args.length === 2 && lastType?.kind === "func" ? lastType.params.length : -1;
    const third = args.length === 3 ? lastType : undefined;
    if (
      args.length < 1 ||
      args.length > 3 ||
      !cryptoNumberArgs(lowerer, numbers) ||
      extra > 2 ||
      (third !== undefined && (third.kind !== "func" || third.params.length > 2))
    ) {
      // The callback is the callable value in the max or the callback
      // position; when neither can hold a function, the synchronous entry
      // runs Node's same checks and no scheduling.
      const callbackCapable =
        (args.length >= 2 && typeHoldsFunction(lowerer, args[1]!)) ||
        (args.length >= 3 && typeHoldsFunction(lowerer, args[2]!));
      return dynCall(
        lowerer,
        expr,
        3,
        callbackCapable ? "crypto.randomIntAnyCb" : "crypto.randomIntAny",
        DYN,
      );
    }
    const min =
      numbers.length === 1
        ? ({ kind: "numLit", value: 0, type: F64, loc } satisfies IrExpr)
        : lowerer.lowerExprExpecting(numbers[0]!, F64);
    const max = lowerer.lowerExprExpecting(numbers[numbers.length - 1]!, F64);
    if (!withCallback) {
      if (numbers.length === 1)
        return { kind: "libCall", fn: "crypto.randomIntMax", args: [max], type: F64, loc };
      return { kind: "libCall", fn: "crypto.randomInt", args: [min, max], type: F64, loc };
    }
    const callback = errorFirstCallback(
      lowerer,
      last!,
      "crypto.randomInt",
      (value) => value.kind === "f64",
      "number",
    );
    const minGiven: IrExpr = {
      kind: "numLit",
      value: numbers.length === 2 ? 1 : 0,
      type: F64,
      loc,
    };
    return {
      kind: "libCall",
      fn: "crypto.randomIntCb",
      args: [min, max, minGiven, callback],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "randomUUID" && args.length > 0) {
    if (args.length > 1 || args.some(ts.isSpreadElement))
      lowerer.noLowering(
        `crypto.randomUUID with ${args.length} arguments`,
        expr,
        "randomUUID([options]) is supported",
      );
    return {
      kind: "libCall",
      fn: "crypto.randomUUIDOpts",
      args: [dynArg(lowerer, args[0], loc)],
      type: STRING,
      loc,
    };
  }
  const pki = lowerPkiCall(lowerer, expr, bi.member, args, loc);
  if (pki) return pki;
  const prime = lowerPrimeCall(lowerer, expr, bi.member, args, loc);
  if (prime) return prime;
  if (bi.member === "createSecretKey") {
    if (args.length > 2 || args.some(ts.isSpreadElement))
      lowerer.noLowering(
        `crypto.createSecretKey with ${args.length} arguments`,
        expr,
        "createSecretKey(key[, encoding]) is supported",
      );
    return {
      kind: "libCall",
      fn: "crypto.createSecretKey",
      args: [
        args[0] ? lowerer.lowerExprExpecting(args[0], DYN) : dynArg(lowerer, undefined, loc),
        dynArg(lowerer, args[1], loc),
      ],
      type: DYN,
      loc,
    };
  }
  if (bi.member === "generateKeySync") {
    if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement))
      lowerer.noLowering(
        `crypto.generateKeySync with ${args.length} arguments`,
        expr,
        "generateKeySync(type, options) is supported",
      );
    return {
      kind: "libCall",
      fn: "crypto.generateKeySync",
      args: [lowerer.lowerExprExpecting(args[0]!, DYN), dynArg(lowerer, args[1], loc)],
      type: DYN,
      loc,
    };
  }
  if (bi.member === "generateKey") {
    if (args.length < 1 || args.length > 3 || args.some(ts.isSpreadElement))
      lowerer.noLowering(
        `crypto.generateKey with ${args.length} arguments`,
        expr,
        "generateKey(type, options, callback) is supported",
      );
    const isFunction = (node: ts.Expression | undefined): boolean =>
      !!node && lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "func";
    // Node takes a function in the options position as the callback, and
    // checks the callback before the type and options.
    const optionsNode = args.length === 2 && isFunction(args[1]) ? undefined : args[1];
    const callbackNode = args.length === 2 && isFunction(args[1]) ? args[1] : args[2];
    // A callback position that cannot hold a function throws Node's check
    // here; a checked-dynamic or unmappable one may be a function at run
    // time and takes the real callback path, where the call site's function
    // check runs.
    const type = lowerer.lowerExprExpecting(args[0]!, DYN);
    const options = dynArg(lowerer, optionsNode, loc);
    if (callbackNode === undefined || !typeHoldsFunction(lowerer, callbackNode)) {
      const got = callbackNode
        ? lowerer.lowerExprExpecting(callbackNode, DYN)
        : dynUndefinedExpr(loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "exprStmt", expr: type, loc },
          { kind: "exprStmt", expr: options, loc },
        ],
        result: {
          kind: "libCall",
          fn: "error.argTypeThrow",
          args: [
            { kind: "strLit", value: "callback", type: STRING, loc },
            { kind: "strLit", value: "of type function", type: STRING, loc },
            got,
          ],
          type: VOID,
          loc,
        },
        type: VOID,
        loc,
      };
    }
    if (lowerer.mapTypeOf(lowerer.typeOf(callbackNode))?.kind === "func") {
      const callback = errorFirstCallback(
        lowerer,
        callbackNode,
        "crypto.generateKey",
        () => false,
        "KeyObject",
      );
      return {
        kind: "libCall",
        fn: "crypto.generateKeyCb",
        args: [type, options, callback],
        type: VOID,
        loc,
      };
    }
    // A callback only the dynamic checker can see: the values are evaluated
    // in source order, then Node's function gate runs where Node validates
    // the callback — after every argument, before the type and options.
    const gkType = lowerer.declareHiddenLocal("%generateKeyType", DYN);
    const gkOptions = lowerer.declareHiddenLocal("%generateKeyOptions", DYN);
    const gkCallback = lowerer.declareHiddenLocal("%generateKeyCallback", DYN);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: gkType.id, init: type, loc },
        { kind: "varDecl", localId: gkOptions.id, init: options, loc },
        {
          kind: "varDecl",
          localId: gkCallback.id,
          init: lowerer.lowerExprExpecting(callbackNode, DYN),
          loc,
        },
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "crypto.checkCallback",
            args: [varRef(gkCallback.id, DYN, loc)],
            type: VOID,
            loc,
          },
          loc,
        },
      ],
      result: {
        kind: "libCall",
        fn: "crypto.generateKeyCb",
        args: [
          varRef(gkType.id, DYN, loc),
          varRef(gkOptions.id, DYN, loc),
          voidizedCallback(
            lowerer,
            {
              kind: "dynCheck",
              value: varRef(gkCallback.id, DYN, loc),
              type: funcOf([DYN, DYN], VOID),
              loc,
            },
            loc,
          ),
        ],
        type: VOID,
        loc,
      },
      type: VOID,
      loc,
    };
  }
  if (bi.member === "randomUUIDv7") {
    if (args.length > 1 || args.some(ts.isSpreadElement))
      lowerer.noLowering(
        `crypto.randomUUIDv7 with ${args.length} arguments`,
        expr,
        "randomUUIDv7([options]) is supported",
      );
    return {
      kind: "libCall",
      fn: "crypto.randomUUIDv7",
      args: [dynArg(lowerer, args[0], loc)],
      type: STRING,
      loc,
    };
  }
  if (bi.member === "pbkdf2Sync") {
    // Missing, surplus and wrongly typed arguments take Node's checks at
    // run time, in its order: digest, password, salt, iterations, keylen.
    if (
      args.length !== 5 ||
      args.some(ts.isSpreadElement) ||
      !isByteInputType(lowerer, args[0]) ||
      !isByteInputType(lowerer, args[1]) ||
      lowerer.mapTypeOf(lowerer.typeOf(args[2]!))?.kind !== "f64" ||
      lowerer.mapTypeOf(lowerer.typeOf(args[3]!))?.kind !== "f64" ||
      lowerer.mapTypeOf(lowerer.typeOf(args[4]!))?.kind !== "string"
    ) {
      return dynCall(lowerer, expr, 5, "crypto.pbkdf2Any", BYTES_U8);
    }
    const password = lowerBuiltinByteInput(lowerer, args[0]!, locOf(args[0]!), "crypto");
    const salt = lowerBuiltinByteInput(lowerer, args[1]!, locOf(args[1]!), "crypto");
    return {
      kind: "libCall",
      fn: "crypto.pbkdf2",
      args: [
        password,
        salt,
        lowerer.lowerExprExpecting(args[2]!, F64),
        lowerer.lowerExprExpecting(args[3]!, F64),
        cryptoAlgorithm(lowerer, args[4]!),
      ],
      type: BYTES_U8,
      loc,
    };
  }
  if (bi.member === "secureHeapUsed") {
    if (expr.arguments.nodes.length !== 0) {
      lowerer.noLowering(
        `crypto.secureHeapUsed with ${expr.arguments.nodes.length} arguments`,
        expr,
      );
    }
    return { kind: "libCall", fn: "crypto.secureHeapUsed", args: [], type: DYN, loc };
  }
  const LISTS: Record<string, readonly string[] | undefined> = {
    getCiphers: CRYPTO_CIPHERS,
    getHashes: CRYPTO_HASHES,
    getCurves: CRYPTO_CURVES,
    getMacs: CRYPTO_MACS,
  };
  const list = own(LISTS, bi.member);
  if (bi.member !== "getFips" && list === undefined) return null;
  if (expr.arguments.nodes.length !== 0) {
    lowerer.noLowering(`crypto.${bi.member} with ${expr.arguments.nodes.length} arguments`, expr);
  }
  if (bi.member === "getFips") {
    return { kind: "numLit", value: 0, type: F64, loc };
  }
  return {
    kind: "arrayLit",
    elems: list!.map((s): IrExpr => ({ kind: "strLit", value: s, type: STRING, loc })),
    type: arrayOf(STRING),
    loc,
  };
}

/** The implemented cipher names and OpenSSL's aliases for them,
 * lower-cased (scr_cipher.c's table). */
const IMPLEMENTED_CIPHERS = new Set([
  "aes-128-cbc",
  "aes-192-cbc",
  "aes-256-cbc",
  "aes128",
  "aes192",
  "aes256",
  "aes-128-ctr",
  "aes-192-ctr",
  "aes-256-ctr",
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "id-aes128-gcm",
  "id-aes192-gcm",
  "id-aes256-gcm",
  "chacha20-poly1305",
  ...["128", "192", "256"].flatMap((bits) => [
    ...["ecb", "cfb", "cfb8", "cfb1", "ofb", "ccm"].map((mode) => `aes-${bits}-${mode}`),
    `id-aes${bits}-ccm`,
    ...["wrap", "wrap-pad"].flatMap((wrap) => [
      `aes-${bits}-${wrap}`,
      `aes${bits}-${wrap}`,
      `id-aes${bits}-${wrap}`,
      `aes-${bits}-${wrap}-inv`,
      `aes${bits}-${wrap}-inv`,
    ]),
  ]),
  "des-ede3-cbc",
  "des3",
  "des-ede3",
  "des-ede3-ecb",
  "des-ede3-cfb",
  "des-ede3-cfb8",
  "des-ede3-cfb1",
  "des-ede3-ofb",
  "des-ede-cbc",
  "des-ede",
  "des-ede-ecb",
  "des-ede-cfb",
  "des-ede-ofb",
  "chacha20",
]);

const SUPPORTED_CIPHERS_HINT =
  "the supported ciphers are aes-128, aes-192 and aes-256 in cbc, ctr, gcm, ccm, ecb, cfb, cfb8, " +
  "cfb1 and ofb modes and their wrap, wrap-pad, wrap-inv and wrap-pad-inv key wraps, des-ede3 in " +
  "cbc, ecb, cfb, cfb8, cfb1 and ofb modes, des-ede in cbc, ecb, cfb and ofb modes, chacha20, and " +
  "chacha20-poly1305";

/** A literal cipher name that Node knows but the runtime does not
 * implement is refused at compile time. Unknown literal names keep Node's
 * runtime ERR_CRYPTO_UNKNOWN_CIPHER. */
function checkCipherName(lowerer: Lowerer, node: ts.Expression, use: string): void {
  const type = lowerer.typeOf(node);
  if (!type.isStringLiteralType()) return;
  const name = type.value.toLowerCase();
  if (IMPLEMENTED_CIPHERS.has(name) || !CRYPTO_CIPHERS.includes(name)) return;
  lowerer.noLowering(`${use} with cipher '${type.value}'`, node, SUPPORTED_CIPHERS_HINT);
}

/** Whether a checker type is node:crypto's Cipheriv/Decipheriv family. */
export function isCipherType(lowerer: Lowerer, type: ts.Type): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return (
    !!symbol &&
    CIPHER_TYPE_NAMES.has(ts.symbolName(symbol)) &&
    symbol.declarations.some((d) => lowerer.isStdlibFile(ts.getSourceFileOfNode(d)))
  );
}

const CIPHER_METHODS = new Set([
  "update",
  "final",
  "setAAD",
  "setAutoPadding",
  "getAuthTag",
  "setAuthTag",
]);

/** V8's spelling of a callee in "is not a function" messages: call
 * arguments render as "(...)", and type syntax (`!`, `as`, `satisfies`,
 * `<T>` assertions) and parentheses disappear, because the running
 * JavaScript has no trace of them. */
export function v8CalleeText(node: ts.Expression): string {
  if (
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertion(node)
  )
    return v8CalleeText(node.expression);
  if (ts.isPropertyAccessExpression(node))
    return `${v8CalleeText(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${v8CalleeText(node.expression)}(...)`;
  return ts.getTextOfNode(node);
}

/** Calls on native Cipheriv/Decipheriv handles dispatch through the
 * handle's methods with checked-dynamic arguments. The stream.Transform
 * members the classes inherit lower over the cipher's Transform
 * (lowerHashStreamCall, which runs first); other members are refused. */
export function lowerCipherMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isCipherType(lowerer, lowerer.typeOf(access.expression))) return null;
  const name = access.name.text;
  if (!CIPHER_METHODS.has(name)) {
    lowerer.noLowering(
      `Cipheriv/Decipheriv.${name}`,
      call,
      "update(), final(), setAAD(), setAutoPadding(), getAuthTag(), setAuthTag(), and the stream members are supported",
    );
  }
  if (call.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`Cipheriv/Decipheriv.${name} with spread arguments`, call);
  const loc = locOf(call);
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: name,
    calleeName: v8CalleeText(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc,
  };
}

/** Calls on native crypto.Hash/Hmac handles. The handle survives locals,
 * aliases, loops, and returns; update() retains and returns the receiver,
 * digest() finalizes it, and Hash.copy() snapshots the incremental state. */
export function lowerCryptoHashMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const receiverType = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  if (receiverType?.kind !== "cryptoHash" && receiverType?.kind !== "cryptoHmac") return null;
  const name = access.name.text;
  const loc = locOf(call);
  // Hmac has no copy(): Node reads the member as undefined and throws a
  // TypeError once the arguments are evaluated.
  if (receiverType.kind === "cryptoHmac" && name === "copy") {
    if (call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("Hmac.copy with spread arguments", call);
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
  if (!lowerer.isStdlibMember(access)) return null;
  const receiver = (): IrExpr => lowerer.lowerExprExpecting(access.expression, receiverType);
  const hash = receiverType.kind === "cryptoHash";
  const label = hash ? "Hash" : "Hmac";
  if (call.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`${label}.${name} with spread arguments`, call);
  if (name === "update") {
    // A missing or surplus argument takes Node's "data" check at run time
    // (an extra argument is evaluated and dropped).
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 2) {
      return dynHashCall(
        lowerer,
        call,
        access,
        receiverType,
        2,
        hash ? "crypto.hashUpdateDyn" : "crypto.hmacUpdateDyn",
        receiverType,
      );
    }
    const target = receiver();
    const dataNode = call.arguments.nodes[0]!;
    const encodingNode = call.arguments.nodes[1];
    const dataType = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
    // Indexed reads can retain optional storage after a nullish fallback
    // or narrowing. Use the proven argument type through a checked coercion.
    const data =
      dataType?.kind === "string" || dataType?.kind === "bytes"
        ? lowerer.lowerExprExpecting(dataNode, dataType)
        : lowerer.lowerExpr(dataNode);
    const prefix = hash ? "crypto.hashUpdate" : "crypto.hmacUpdate";
    const encodingType = encodingNode ? lowerer.mapTypeOf(lowerer.typeOf(encodingNode)) : undefined;
    if (data.type.kind === "bytes" && encodingNode === undefined) {
      return {
        kind: "libCall",
        fn: `${prefix}Bytes` as IrLibFn,
        args: [target, cryptoByteView(lowerer, dataNode, data)],
        type: receiverType,
        loc,
      };
    }
    if (data.type.kind === "string") {
      const literal = encodingNode ? stringLiteralValues(lowerer.typeOf(encodingNode)) : undefined;
      const utf8 =
        encodingNode === undefined ||
        (literal?.length === 1 && cryptoEncodingName(literal[0]!) === "utf8");
      if (utf8) {
        if (encodingNode) lowerer.lowerExprExpecting(encodingNode, STRING);
        return {
          kind: "libCall",
          fn: `${prefix}Str` as IrLibFn,
          args: [target, data],
          type: receiverType,
          loc,
        };
      }
      if (encodingType?.kind === "string") {
        return {
          kind: "libCall",
          fn: `${prefix}Enc` as IrLibFn,
          args: [target, data, lowerer.lowerExprExpecting(encodingNode!, STRING)],
          type: receiverType,
          loc,
        };
      }
    }
    // Other data and encodings take Node's checks at run time: views and
    // strings hash, anything else throws ERR_INVALID_ARG_TYPE.
    return {
      kind: "libCall",
      fn: `${prefix}Dyn` as IrLibFn,
      args: [target, lowerer.coerceInto(dataNode, data, DYN), dynArg(lowerer, encodingNode, loc)],
      type: receiverType,
      loc,
    };
  }
  if (name === "digest") {
    // A surplus argument is evaluated and dropped, as Node does.
    if (call.arguments.nodes.length > 1) {
      return dynHashCall(
        lowerer,
        call,
        access,
        receiverType,
        1,
        hash ? "crypto.hashDigestDyn" : "crypto.hmacDigestDyn",
        DYN,
      );
    }
    const encodingNode = call.arguments.nodes[0];
    if (encodingNode === undefined) {
      return {
        kind: "libCall",
        fn: hash ? "crypto.hashDigestBuffer" : "crypto.hmacDigestBuffer",
        args: [receiver()],
        type: BYTES_U8,
        loc,
      };
    }
    if (isStringDigestEncoding(lowerer, encodingNode, false)) {
      return {
        kind: "libCall",
        fn: hash ? "crypto.hashDigestString" : "crypto.hmacDigestString",
        args: [receiver(), lowerer.lowerExprExpecting(encodingNode, STRING)],
        type: STRING,
        loc,
      };
    }
    // Node returns a Buffer for a falsy or unknown encoding. A literal
    // whose Buffer result the declared string type cannot hold is refused.
    const literal = stringLiteralValues(lowerer.typeOf(encodingNode));
    const declared = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (literal && declared?.kind === "string") {
      lowerer.noLowering(
        `${label}.digest with encoding '${literal.join("' | '")}'`,
        encodingNode,
        "Node returns a Buffer for this encoding, and the call's declared type is string",
      );
    }
    return {
      kind: "libCall",
      fn: hash ? "crypto.hashDigestDyn" : "crypto.hmacDigestDyn",
      args: [receiver(), lowerer.lowerExprExpecting(encodingNode, DYN)],
      type: DYN,
      loc,
    };
  }
  if (name === "copy" && hash) {
    // A surplus argument is evaluated and dropped, as Node does.
    if (call.arguments.nodes.length > 1)
      return dynHashCall(
        lowerer,
        call,
        access,
        receiverType,
        1,
        "crypto.hashCopyOpts",
        CRYPTOHASH_T,
      );
    if (call.arguments.nodes.length === 0)
      return {
        kind: "libCall",
        fn: "crypto.hashCopy",
        args: [receiver()],
        type: CRYPTOHASH_T,
        loc,
      };
    return {
      kind: "libCall",
      fn: "crypto.hashCopyOpts",
      args: [receiver(), lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN)],
      type: CRYPTOHASH_T,
      loc,
    };
  }
  lowerer.noLowering(
    `${receiverType.kind === "cryptoHash" ? "Hash" : "Hmac"}.${name}`,
    call,
    receiverType.kind === "cryptoHash"
      ? "update(), digest(), and copy() are supported"
      : "update() and digest() are supported",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The crypto callback functions util.promisify converts. */
const PROMISIFIED_CRYPTO_ARITY: Readonly<Record<string, readonly [number, number] | undefined>> = {
  randomBytes: [1, 1],
  pbkdf2: [5, 5],
  scrypt: [3, 4],
  hkdf: [5, 5],
  randomFill: [1, 3],
  randomInt: [1, 2],
  generateKey: [1, 2],
};

export function isPromisifiedCryptoMember(member: string): boolean {
  return PROMISIFIED_CRYPTO_ARITY[member] !== undefined;
}

/** A call through `promisify(crypto.randomBytes)` and the other callback
 * functions: the callback form runs with a callback that settles the
 * returned promise, so the value or error arrives where the callback
 * would run. An argument error rejects the promise instead of throwing,
 * as the throw inside Node's promisify wrapper does. The promise's value
 * type follows the declared result: a Buffer or the filled view, or a
 * checked-dynamic value where the declarations give `unknown`. */
export function lowerPromisifiedCryptoCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`the promisified crypto.${member} with spread arguments`, expr);
  }
  const [min, max] = PROMISIFIED_CRYPTO_ARITY[member]!;
  if (args.length < min || args.length > max) {
    lowerer.noLowering(
      `the promisified crypto.${member} with ${args.length} arguments`,
      expr,
      `the promisified form takes the callback form's arguments without the callback`,
    );
  }
  const declared = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const inner = declared?.kind === "promise" ? declared.inner : null;
  const promise = (
    fn: IrLibFn,
    values: IrExpr[],
    accepts: (t: IrType) => boolean,
    what: string,
  ): IrExpr => {
    if (inner === null || !accepts(inner)) {
      lowerer.noLowering(
        `the promisified crypto.${member} with a '${declared ? lowerer.fmt(declared) : "?"}' result`,
        expr,
        `the promise's value type must be ${what} or unknown`,
      );
    }
    return { kind: "libCall", fn, args: values, type: { kind: "promise", inner }, loc };
  };
  const bufferOrDyn = (t: IrType) => t.kind === "dyn" || (t.kind === "bytes" && t.elem === "u8");
  if (member === "randomBytes") {
    return promise(
      "crypto.randomBytesPromise",
      [lowerer.lowerExprExpecting(args[0]!, F64)],
      bufferOrDyn,
      "Buffer",
    );
  }
  if (member === "pbkdf2") {
    return promise(
      "crypto.pbkdf2Promise",
      [
        lowerBuiltinByteInput(lowerer, args[0]!, locOf(args[0]!), "crypto"),
        lowerBuiltinByteInput(lowerer, args[1]!, locOf(args[1]!), "crypto"),
        lowerer.lowerExprExpecting(args[2]!, F64),
        lowerer.lowerExprExpecting(args[3]!, F64),
        cryptoAlgorithm(lowerer, args[4]!),
      ],
      bufferOrDyn,
      "Buffer",
    );
  }
  if (member === "scrypt") {
    return promise(
      "crypto.scryptPromise",
      [
        cryptoKdfInput(lowerer, args[0]!),
        cryptoKdfInput(lowerer, args[1]!),
        lowerer.lowerExprExpecting(args[2]!, F64),
        args[3]
          ? lowerer.coerceInto(args[3], lowerer.lowerExpr(args[3]), DYN)
          : dynUndefinedExpr(loc),
      ],
      bufferOrDyn,
      "Buffer",
    );
  }
  if (member === "hkdf") {
    return promise(
      "crypto.hkdfPromise",
      [
        cryptoAlgorithm(lowerer, args[0]!),
        isKeyObjectValue(lowerer, args[1]!)
          ? {
              kind: "libCall",
              fn: "crypto.keyObjectInput",
              args: [lowerer.lowerExprExpecting(args[1]!, DYN)],
              type: BYTES_U8,
              loc,
            }
          : cryptoKdfInput(lowerer, args[1]!),
        cryptoKdfInput(lowerer, args[2]!),
        cryptoKdfInput(lowerer, args[3]!),
        lowerer.lowerExprExpecting(args[4]!, F64),
      ],
      (t) => t.kind === "dyn",
      "ArrayBuffer",
    );
  }
  if (member === "randomFill") {
    // Node's randomFill counts the arguments before the callback.
    const form: IrExpr = { kind: "numLit", value: args.length, type: F64, loc };
    const buffer = lowerer.lowerExpr(args[0]!);
    if (buffer.type.kind === "bytes" && cryptoNumberArgs(lowerer, args.slice(1))) {
      const view = buffer.type;
      return promise(
        "crypto.randomFillPromise",
        [
          buffer,
          args.length >= 2
            ? lowerer.lowerExprExpecting(args[1]!, F64)
            : { kind: "numLit", value: 0, type: F64, loc },
          args.length === 3
            ? lowerer.lowerExprExpecting(args[2]!, F64)
            : { kind: "numLit", value: 0, type: F64, loc },
          form,
        ],
        (t) => t.kind === "dyn" || (t.kind === "bytes" && t.elem === view.elem),
        "the buffer's own view",
      );
    }
    return promise(
      "crypto.randomFillPromiseDyn",
      [
        lowerer.coerceInto(args[0]!, buffer, DYN),
        dynArg(lowerer, args[1], loc),
        dynArg(lowerer, args[2], loc),
        form,
      ],
      (t) => t.kind === "dyn",
      "the buffer's own type",
    );
  }
  if (member === "randomInt") {
    return promise(
      "crypto.randomIntPromise",
      [
        args.length === 2
          ? lowerer.lowerExprExpecting(args[0]!, F64)
          : { kind: "numLit", value: 0, type: F64, loc },
        lowerer.lowerExprExpecting(args[args.length - 1]!, F64),
        { kind: "numLit", value: args.length === 2 ? 1 : 0, type: F64, loc },
      ],
      (t) => t.kind === "dyn" || t.kind === "f64",
      "number",
    );
  }
  return promise(
    "crypto.generateKeyPromise",
    [lowerer.lowerExprExpecting(args[0]!, DYN), dynArg(lowerer, args[1], loc)],
    (t) => t.kind === "dyn",
    "KeyObject",
  );
}

/** `crypto.getRandomValues(view)` — the WebCrypto global, node:crypto's
 * export and `webcrypto.getRandomValues`: a typed view fills in place and
 * returns itself at its own type (float views, DataViews and views over
 * 65536 bytes throw Node's DOMExceptions at run time); any other value
 * takes the checked form. Null for other arities (the member fence keeps
 * them). */
export function lowerCryptoGetRandomValues(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!))
    return null;
  const loc = locOf(call);
  const value = lowerer.lowerExpr(call.arguments.nodes[0]!);
  if (value.type.kind === "bytes")
    return { kind: "libCall", fn: "crypto.getRandomValues", args: [value], type: value.type, loc };
  return {
    kind: "libCall",
    fn: "crypto.getRandomValuesDyn",
    args: [lowerer.coerceInto(call.arguments.nodes[0]!, value, DYN)],
    type: DYN,
    loc,
  };
}

/** Whether `receiver` names a WebCrypto Crypto object: the `crypto`
 * global (also through globalThis or an alias of it) or node:crypto's
 * `webcrypto`. */
export function isWebCryptoReceiver(lowerer: Lowerer, receiver: ts.Expression): boolean {
  if (stdlibGlobalNameOf(lowerer, receiver) === "crypto") return true;
  if (ts.isIdentifier(receiver)) {
    if (receiver.text === "crypto" && lowerer.isStdlibGlobal(receiver, "crypto")) return true;
    const imported = lowerer.builtinImportOf(receiver);
    return imported?.module === "crypto" && imported.member === "webcrypto";
  }
  if (ts.isPropertyAccessExpression(receiver) && !receiver.questionDotToken) {
    if (
      receiver.name.text === "crypto" &&
      ts.isIdentifier(receiver.expression) &&
      lowerer.isStdlibGlobal(receiver.expression, "globalThis")
    )
      return true;
    const member = lowerer.builtinMemberOf(receiver);
    return member?.module === "crypto" && member.member === "webcrypto";
  }
  return false;
}

/** Node calls checkPrime's and generatePrime's callbacks with undefined as
 * the error, where @types/node declares Error | null: whether this
 * callback's error parameter can hold undefined. One that cannot receives
 * null instead. */
function takesUndefinedError(lowerer: Lowerer, callback: ts.Expression): boolean {
  const type = lowerer.irTypeOf(callback);
  if (type.kind !== "func") return true;
  const error = type.params[0];
  if (error === undefined || error.kind === "dyn" || error.kind === "undefinedT") return true;
  if (error.kind !== "union") return false;
  return !!lowerer.unions.get(error.unionId)?.arms.some((arm) => arm.kind === "undefinedT");
}

/** checkPrime, checkPrimeSync, generatePrime and generatePrimeSync
 * (scr_dh.c), and getCipherInfo (scr_cipher_info.c): checked-dynamic
 * arguments, which the runtime checks as Node does (a function in the
 * options position is the callback), and the sync forms' boolean,
 * ArrayBuffer, bigint or info object converted to the call site's type.
 * Null for other members. */
function lowerPrimeCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  args: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr | null {
  const forms: Readonly<Record<string, readonly [IrLibFn, number, number, string]>> = {
    checkPrimeSync: ["crypto.checkPrimeSync", 1, 2, "checkPrimeSync(candidate[, options])"],
    checkPrime: ["crypto.checkPrimeCb", 1, 3, "checkPrime(candidate[, options], callback)"],
    generatePrimeSync: ["crypto.generatePrimeSync", 1, 2, "generatePrimeSync(size[, options])"],
    getCipherInfo: ["crypto.getCipherInfo", 0, 2, "getCipherInfo(nameOrNid[, options])"],
    generatePrime: ["crypto.generatePrimeCb", 1, 3, "generatePrime(size[, options], callback)"],
  };
  const form = forms[member];
  if (!form) return null;
  const [fn, min, max, supported] = form;
  if (args.length < min || args.some(ts.isSpreadElement))
    lowerer.noLowering(
      `crypto.${member} with ${args.length} arguments`,
      expr,
      `${supported} is supported`,
    );
  // Node reads its arguments by position and ignores the ones after the
  // last it declares; they still evaluate, in source order.
  const { stmts, args: values } = dynCallArgs(lowerer, expr, max);
  const sequence = (result: IrExpr): IrExpr =>
    stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: result.type, loc };
  if (fn === "crypto.checkPrimeCb" || fn === "crypto.generatePrimeCb") {
    const callback = primeCallback(lowerer, args, max);
    const nullError = callback !== undefined && !takesUndefinedError(lowerer, callback);
    values.push({ kind: "boolLit", value: nullError, type: BOOL, loc });
    return sequence({ kind: "libCall", fn, args: values, type: VOID, loc });
  }
  const call: IrExpr = { kind: "libCall", fn, args: values, type: DYN, loc };
  const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (result === null || result.kind === "dyn") return sequence(call);
  return lowerer.coerceInto(expr, sequence(call), result);
}

/** The callback checkPrime and generatePrime read: a function in the
 * options position, otherwise the last argument they declare. */
function primeCallback(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  max: number,
): ts.Expression | undefined {
  const options = args[1];
  if (options !== undefined && lowerer.mapTypeOf(lowerer.typeOf(options))?.kind === "func")
    return options;
  return args[max - 1];
}

/** The asymmetric-key and signature members (scr_pki.c): checked-dynamic
 * arguments, and the result converted to the call site's type
 * (KeyObject, Sign and Verify are checked-dynamic handles; key pairs,
 * signatures and verdicts convert to their records, Buffers and
 * booleans). Null for other members. */
function lowerPkiCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  args: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr | null {
  const forms: Readonly<Record<string, readonly [IrLibFn, number, number, string]>> = {
    createPrivateKey: ["crypto.createPrivateKey", 1, 1, "createPrivateKey(key)"],
    createPublicKey: ["crypto.createPublicKey", 1, 1, "createPublicKey(key)"],
    generateKeyPairSync: ["crypto.generateKeyPairSync", 1, 2, "generateKeyPairSync(type, options)"],
    generateKeyPair: [
      "crypto.generateKeyPairCb",
      2,
      3,
      "generateKeyPair(type, [options,] callback)",
    ],
    sign: ["crypto.signOneshot", 3, 4, "sign(algorithm, data, key[, callback])"],
    verify: ["crypto.verifyOneshot", 4, 5, "verify(algorithm, data, key, signature[, callback])"],
    publicEncrypt: ["crypto.publicEncrypt", 2, 2, "publicEncrypt(key, buffer)"],
    privateDecrypt: ["crypto.privateDecrypt", 2, 2, "privateDecrypt(key, buffer)"],
    privateEncrypt: ["crypto.privateEncrypt", 2, 2, "privateEncrypt(key, buffer)"],
    publicDecrypt: ["crypto.publicDecrypt", 2, 2, "publicDecrypt(key, buffer)"],
    diffieHellman: ["crypto.diffieHellman", 1, 2, "diffieHellman(options[, callback])"],
    createSign: ["crypto.createSign", 0, 2, "createSign(algorithm[, options])"],
    createVerify: ["crypto.createVerify", 0, 2, "createVerify(algorithm[, options])"],
    setEngine: ["crypto.setEngine", 1, 2, "setEngine(engine[, flags])"],
  };
  const form = forms[member];
  if (!form) return null;
  const [baseFn, min, max, supported] = form;
  // sign and verify take an optional trailing callback, and Node checks
  // every other argument count at run time: missing arguments answer the
  // errors of the checks they fail, surplus ones evaluate and are ignored.
  if (member === "sign" || member === "verify") {
    const syncCount = member === "sign" ? 3 : 4;
    const syncFn: IrLibFn = member === "sign" ? "crypto.signOneshot" : "crypto.verifyOneshot";
    const maybeFn: IrLibFn =
      member === "sign" ? "crypto.signOneshotMaybe" : "crypto.verifyOneshotMaybe";
    const callbackArg = args[syncCount];
    const literalUndefined =
      callbackArg !== undefined &&
      callbackArg.kind === ts.SyntaxKind.Identifier &&
      callbackArg.getText() === "undefined";
    if (args.length === syncCount || (args.length === syncCount + 1 && literalUndefined)) {
      // The declared synchronous shape; a literal undefined callback is
      // no callback at all.
      const values = args.slice(0, syncCount).map((arg) => dynArg(lowerer, arg, loc));
      return pkiResult(lowerer, expr, {
        kind: "libCall",
        fn: syncFn,
        args: values,
        type: DYN,
        loc,
      });
    }
    if (args.length === syncCount + 1) {
      // A callback the checker cannot prove is a function may be
      // undefined at run time, which Node runs synchronously.
      const values = args.map((arg) => dynArg(lowerer, arg, loc));
      return pkiResult(lowerer, expr, {
        kind: "libCall",
        fn: maybeFn,
        args: values,
        type: DYN,
        loc,
      });
    }
    const withCallback = args.length > syncCount && !literalUndefined;
    return pkiResult(
      lowerer,
      expr,
      dynCall(
        lowerer,
        expr,
        withCallback ? syncCount + 1 : syncCount,
        withCallback ? maybeFn : syncFn,
        DYN,
      ),
    );
  }
  if (args.length < min || args.length > max) {
    // Node ignores surplus arguments, which still evaluate in source order.
    if (member === "createSign" || member === "createVerify")
      return pkiResult(lowerer, expr, dynCall(lowerer, expr, max, baseFn, DYN));
    lowerer.noLowering(
      `crypto.${member} with ${args.length} arguments`,
      expr,
      `${supported} is supported`,
    );
  }
  // generateKeyPair(type, callback): the runtime reads a function in the
  // options position as the callback, as Node does.
  const values: IrExpr[] = [];
  for (let i = 0; i < max; i++) values.push(dynArg(lowerer, args[i], loc));
  if (baseFn === "crypto.generateKeyPairCb" || baseFn === "crypto.setEngine")
    return { kind: "libCall", fn: baseFn, args: values, type: VOID, loc };
  return pkiResult(lowerer, expr, { kind: "libCall", fn: baseFn, args: values, type: DYN, loc });
}

/** An asymmetric-key entry's checked-dynamic result as the call site's
 * type (KeyObject, Sign and Verify handles stay dynamic; signatures,
 * key pairs and verdicts convert to their Buffers, records and
 * booleans). */
function pkiResult(lowerer: Lowerer, expr: ts.CallExpression, call: IrExpr): IrExpr {
  const callType = lowerer.typeOf(expr);
  /* A literal undefined callback fails overload resolution (the checker
   * types the call never); it was rewritten to the synchronous entry point,
   * whose result stays checked-dynamic. */
  if ((callType.flags & ts.TypeFlags.Never) !== 0) return call;
  const result = lowerer.mapTypeOf(callType);
  // diffieHellman's callback form answers undefined.
  if (result === null || result.kind === "dyn" || result.kind === "void") return call;
  return lowerer.coerceInto(expr, call, result);
}
