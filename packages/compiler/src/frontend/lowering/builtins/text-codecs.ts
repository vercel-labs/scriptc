import { keyedHelperName } from "../stable-names.js";
import { isBuiltinClassInstance } from "./receiver-types.js";
import { strLit, varRef, dynUndefinedExpr } from "../../../ir/build.js";
import { staticTextDecoderEncoding } from "../text-decoder-encoding.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
} from "../../../ir/ir.js";
import {
  lowerBuiltinValuePreservingUndefined,
  checkedOptionalBuiltinArm,
  stripTypeCasts,
} from "./arguments.js";
import { type BuiltinModuleFn } from "../surfaces.js";

/** The input of `decoder.decode(input)`. An undefined input decodes no bytes,
 * as `decode()` does in Node: a statically undefined argument (after its
 * effects) reads as an empty Uint8Array, and the undefined arm of a typed
 * array or view that may be undefined (`Uint8Array | undefined`,
 * `Uint16Array | undefined`) as an empty view of the same type. */
function lowerDecodeInput(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg)
    return defaultAfterUndefined(undefinedArg, {
      kind: "bytesNew",
      source: null,
      type: BYTES_U8,
      loc,
    });
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "union") {
    const def = lowerer.unions.get(value.type.unionId);
    const view = def?.arms.find((arm) => arm.kind === "bytes");
    if (def?.arms.length === 2 && view && def.arms.some((arm) => arm.kind === "undefinedT"))
      return {
        kind: "nullish",
        left: value,
        right: { kind: "bytesNew", source: null, type: view, loc },
        type: view,
        loc,
      };
  }
  return value;
}

/** StringDecoder writes preserve pending bytes; end(input) performs the
 * final write and flushes the state. String input passes through unchanged. */
export function lowerStringDecoderMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!isBuiltinClassInstance(lowerer, access.expression, "StringDecoder")) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (
    (name !== "write" && name !== "end") ||
    call.arguments.nodes.length > 1 ||
    (name === "write" && call.arguments.nodes.length !== 1) ||
    call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `StringDecoder.${name}`,
      call,
      "use write(input) or end(input?)",
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "record")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  if (call.arguments.nodes.length === 0) {
    return {
      kind: "call",
      callee: stringDecoderHelper(lowerer, "end", receiver.type.shapeId, loc),
      args: [receiver],
      type: STRING,
      loc,
    };
  }
  const node = call.arguments.nodes[0]!;
  const undefinedArg = name === "end" ? lowerStaticallyUndefinedArgument(lowerer, node) : null;
  if (undefinedArg) {
    const saved = lowerer.declareHiddenLocal("%strdecRecv", receiver.type);
    const result: IrExpr = {
      kind: "call",
      callee: stringDecoderHelper(lowerer, "end", receiver.type.shapeId, loc),
      args: [varRef(saved.id, receiver.type, loc)],
      type: STRING,
      loc,
    };
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: saved.id, init: receiver, loc }],
      result: defaultAfterUndefined(undefinedArg, result),
      type: STRING,
      loc,
    };
  }
  let chunk = lowerBuiltinValuePreservingUndefined(lowerer, node);
  if (chunk.type.kind === "string") {
    const op = name === "end" ? "endString" : "writeString";
    return {
      kind: "call",
      callee: stringDecoderHelper(lowerer, op, receiver.type.shapeId, loc),
      args: [receiver, chunk],
      type: STRING,
      loc,
    };
  }
  chunk = checkedOptionalBuiltinArm(lowerer, chunk, BYTES_U8) ?? chunk;
  if (chunk.type.kind === "bytes" && chunk.type.elem !== "u8") {
    chunk = {
      kind: "libCall",
      fn: "bytes.bufferSource",
      args: [lowerer.coerceInto(node, chunk, DYN)],
      type: BYTES_U8,
      loc,
    };
  }
  if (!(chunk.type.kind === "bytes" && chunk.type.elem === "u8")) {
    lowerer.noLowering(
      `StringDecoder.${name} of '${lowerer.fmt(chunk.type)}' data`,
      node,
      "pass a string or typed-array view (narrow unions first)",
    );
  }
  const helper = stringDecoderHelper(
    lowerer,
    name === "end" ? "endChunk" : "write",
    receiver.type.shapeId,
    loc,
  );
  return { kind: "call", callee: helper, args: [receiver, chunk], type: STRING, loc };
}

/** The interned %strdec helpers: write(d, chunk) returns the decoded
 * complete prefix and re-buffers the trailing partial into the pending
 * field; end(d) flushes it. Both thread the packed-f64 state through
 * the pure strdec.* libCalls. */
function stringDecoderHelper(
  lowerer: Lowerer,
  op: "write" | "end" | "endChunk" | "endString" | "writeString",
  shapeId: string,
  loc: SrcLoc,
): string {
  const key = `strdec.${op}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, `%strdec.${op}`, key);
  lowerer.valueHelpers.set(key, name);
  const recT: IrType = { kind: "record", shapeId };

  const pendingRead = (): IrExpr => ({
    kind: "recordGet",
    obj: varRef("d.0", recT, loc),
    shapeId,
    field: "%pending",
    type: F64,
    loc,
  });
  const encRead = (): IrExpr => ({
    kind: "recordGet",
    obj: varRef("d.0", recT, loc),
    shapeId,
    field: "%enc",
    type: STRING,
    loc,
  });
  const params: { localId: string; name: string; type: IrType }[] = [
    { localId: "d.0", name: "d", type: recT },
  ];
  const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
    { id: "d.0", name: "d", type: recT, mutable: false },
    { id: "s.0", name: "s", type: STRING, mutable: false },
  ];
  let body: IrStmt[];
  if (op === "write" || op === "endChunk") {
    params.push({ localId: "chunk.0", name: "chunk", type: BYTES_U8 });
    locals.splice(1, 0, { id: "chunk.0", name: "chunk", type: BYTES_U8, mutable: false });
    body = [
      {
        kind: "varDecl",
        localId: "s.0",
        init: {
          kind: "libCall",
          fn: "strdec.write",
          args: [encRead(), pendingRead(), varRef("chunk.0", BYTES_U8, loc)],
          type: STRING,
          loc,
        },
        loc,
      },
      {
        kind: "recordSet",
        obj: varRef("d.0", recT, loc),
        shapeId,
        field: "%pending",
        value: {
          kind: "libCall",
          fn: "strdec.next",
          args: [encRead(), pendingRead(), varRef("chunk.0", BYTES_U8, loc)],
          type: F64,
          loc,
        },
        loc,
      },
      { kind: "return", value: varRef("s.0", STRING, loc), loc },
    ];
  } else {
    body = [
      {
        kind: "varDecl",
        localId: "s.0",
        init: {
          kind: "libCall",
          fn: "strdec.end",
          args: [encRead(), pendingRead()],
          type: STRING,
          loc,
        },
        loc,
      },
      {
        kind: "recordSet",
        obj: varRef("d.0", recT, loc),
        shapeId,
        field: "%pending",
        value: { kind: "numLit", value: 0, type: F64, loc },
        loc,
      },
      { kind: "return", value: varRef("s.0", STRING, loc), loc },
    ];
  }
  if (op === "endString" || op === "writeString") {
    const inputT = STRING;
    params.push({ localId: "chunk.0", name: "chunk", type: inputT });
    locals.push({ id: "chunk.0", name: "chunk", type: inputT, mutable: false });
    if (op === "writeString")
      body = [{ kind: "return", value: varRef("chunk.0", STRING, loc), loc }];
    if (op === "endString")
      body[body.length - 1] = {
        kind: "return",
        value: {
          kind: "strConcat",
          left: varRef("chunk.0", STRING, loc),
          right: varRef("s.0", STRING, loc),
          type: STRING,
          loc,
        },
        loc,
      };
  }
  if (op === "endChunk") {
    locals.push({ id: "tail.0", name: "tail", type: STRING, mutable: false });
    body.splice(
      body.length - 1,
      0,
      {
        kind: "varDecl",
        localId: "tail.0",
        init: {
          kind: "libCall",
          fn: "strdec.end",
          args: [encRead(), pendingRead()],
          type: STRING,
          loc,
        },
        loc,
      },
      {
        kind: "recordSet",
        obj: varRef("d.0", recT, loc),
        shapeId,
        field: "%pending",
        value: { kind: "numLit", value: 0, type: F64, loc },
        loc,
      },
    );
    body[body.length - 1] = {
      kind: "return",
      value: {
        kind: "strConcat",
        left: varRef("s.0", STRING, loc),
        right: varRef("tail.0", STRING, loc),
        type: STRING,
        loc,
      },
      loc,
    };
  }
  lowerer.liftedFns.push({ name, params, returnType: STRING, locals, body, loc });
  return name;
}

type TextCodecCtor = {
  cls: "TextDecoder" | "TextEncoder";
  ctor: ts.NewExpression;
};

/** Box a codec's immutable encoding in an owned record. Unlike erased
 * aliases, this value can live in fields, arguments, and closure captures. */
export function lowerTextCodecNew(
  lowerer: Lowerer,
  ctor: ts.NewExpression,
  cls: TextCodecCtor["cls"],
): IrExpr {
  const args = ctor.arguments?.nodes ?? [];
  const loc = locOf(ctor);
  let encoding: IrExpr = { kind: "numLit", value: -1, type: F64, loc };
  let label: IrExpr | null = null;
  if (cls === "TextEncoder") {
    if (args.length !== 0) lowerer.noLowering("new TextEncoder with arguments", ctor);
  } else if (args.length !== 0) {
    const labelT = lowerer.typeOf(args[0]!);
    const parsed = labelT.isStringLiteralType() ? staticTextDecoderEncoding(labelT.value) : null;
    if (args.length > 2) lowerer.noLowering("new TextDecoder with extra arguments", ctor);
    if (parsed === null) {
      encoding = {
        kind: "libCall",
        fn: "text.decoderEncoding",
        args: [lowerer.lowerExprExpecting(args[0]!, DYN)],
        type: F64,
        loc,
      };
    } else {
      encoding = { kind: "numLit", value: parsed.kind === "utf8" ? -1 : parsed.id, type: F64, loc };
      label = lowerer.lowerExprExpecting(args[0]!, STRING);
    }
  }
  const options = args[1] ? stripTypeCasts(args[1]) : null;
  const flags = new Map<string, IrExpr>();
  for (const name of ["fatal", "ignoreBOM"])
    flags.set(name, { kind: "boolLit", value: false, type: BOOL, loc });
  if (options) {
    if (!ts.isObjectLiteralExpression(options))
      lowerer.noLowering("TextDecoder options outside an object literal", options);
    for (const property of options.properties.nodes) {
      if (
        (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
        !ts.isIdentifier(property.name) ||
        !flags.has(property.name.text)
      )
        lowerer.noLowering("unknown TextDecoder option", property);
      const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      flags.set(property.name.text, lowerer.lowerExprExpecting(value, BOOL));
    }
  }
  const type = lowerer.mapTypeOf(lowerer.typeOf(ctor));
  if (type?.kind !== "record") lowerer.badType(ctor, lowerer.typeOf(ctor));
  const result: IrExpr = {
    kind: "recordLit",
    fields: [
      { name: `%${cls}`, value: encoding },
      ...(cls === "TextDecoder"
        ? [
            ...[...flags].map(([name, value]) => ({ name: `%${name}`, value })),
            { name: "%state", value: { kind: "dynObjLit", fields: [], type: DYN, loc } as IrExpr },
          ]
        : []),
    ],
    type,
    loc,
  };
  return label === null || label.kind === "strLit"
    ? result
    : {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: label, loc }],
        result,
        type,
        loc,
      };
}

export function storedTextCodecClassOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): TextCodecCtor["cls"] | null {
  const sym = lowerer.typeOf(expr).getSymbol();
  if (!sym) return null;
  const name = ts.symbolName(sym);
  if (name !== "TextEncoder" && name !== "TextDecoder") return null;
  return sym.declarations.some(
    (d) =>
      (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) &&
      lowerer.isStdlibFile(ts.getSourceFileOfNode(d)),
  )
    ? name
    : null;
}

function lowerStoredTextCodecCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const cls = storedTextCodecClassOf(lowerer, access.expression);
  if (cls === null || !lowerer.isStdlibMember(access)) return null;
  if (access.name.text !== (cls === "TextEncoder" ? "encode" : "decode")) return null;
  if (call.arguments.nodes.length > (cls === "TextDecoder" ? 2 : 1)) {
    lowerer.noLowering(`${cls}.${access.name.text} with extra arguments`, call);
  }
  const loc = locOf(call);
  let stream: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  if (cls === "TextDecoder" && call.arguments.nodes[1]) {
    const options = stripTypeCasts(call.arguments.nodes[1]);
    if (!ts.isObjectLiteralExpression(options))
      lowerer.noLowering("TextDecoder.decode options outside an object literal", options);
    for (const property of options.properties.nodes) {
      if (
        (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
        !ts.isIdentifier(property.name) ||
        property.name.text !== "stream"
      )
        lowerer.noLowering("unknown TextDecoder.decode option", property);
      stream = lowerer.lowerExprExpecting(
        ts.isPropertyAssignment(property) ? property.initializer : property.name,
        BOOL,
      );
    }
  }
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "record")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  let arg: IrExpr =
    call.arguments.nodes.length === 0
      ? cls === "TextEncoder"
        ? strLit("", loc)
        : { kind: "bytesNew", source: null, type: BYTES_U8, loc }
      : cls === "TextEncoder"
        ? lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING)
        : lowerDecodeInput(lowerer, call.arguments.nodes[0]!, loc);
  if (
    cls === "TextDecoder" &&
    (arg.type.kind === "dyn" || (arg.type.kind === "bytes" && arg.type.elem !== "u8"))
  ) {
    arg = {
      kind: "libCall",
      fn: "bytes.bufferSource",
      args: [lowerer.coerceInto(call.arguments.nodes[0]!, arg, DYN)],
      type: BYTES_U8,
      loc,
    };
  }
  if (cls === "TextDecoder" && !(arg.type.kind === "bytes" && arg.type.elem === "u8")) {
    lowerer.noLowering(
      `TextDecoder.decode of '${lowerer.fmt(arg.type)}' values`,
      call,
      "Uint8Array/Buffer input decodes (ArrayBuffer values have no representation)",
    );
  }
  const key = `textCodec.${cls}.${receiver.type.shapeId}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = `%${key}`;
    lowerer.valueHelpers.set(key, name);
    const recT = receiver.type;
    const input = varRef("input.0", arg.type, loc);
    const result: IrExpr =
      cls === "TextEncoder"
        ? {
            kind: "libCall",
            fn: "buffer.fromStr",
            args: [input, { kind: "strLit", value: "utf8", type: STRING, loc }],
            type: BYTES_U8,
            loc,
          }
        : {
            kind: "libCall",
            fn: "text.decodeStream",
            args: [
              {
                kind: "recordGet",
                obj: varRef("codec.0", recT, loc),
                shapeId: recT.shapeId,
                field: "%state",
                type: DYN,
                loc,
              },
              input,
              {
                kind: "recordGet",
                obj: varRef("codec.0", recT, loc),
                shapeId: recT.shapeId,
                field: "%TextDecoder",
                type: F64,
                loc,
              },
              ...["%fatal", "%ignoreBOM"].map((field): IrExpr => ({
                kind: "recordGet",
                obj: varRef("codec.0", recT, loc),
                shapeId: recT.shapeId,
                field,
                type: BOOL,
                loc,
              })),
              varRef("stream.0", BOOL, loc),
            ],
            type: STRING,
            loc,
          };
    lowerer.liftedFns.push({
      name,
      params: [
        { localId: "codec.0", name: "codec", type: recT },
        { localId: "input.0", name: "input", type: arg.type },
        { localId: "stream.0", name: "stream", type: BOOL },
      ],
      returnType: result.type,
      locals: [
        { id: "codec.0", name: "codec", type: recT, mutable: false },
        { id: "input.0", name: "input", type: arg.type, mutable: false },
        { id: "stream.0", name: "stream", type: BOOL, mutable: false },
      ],
      body: [{ kind: "return", value: result, loc }],
      loc,
    });
  }
  return {
    kind: "call",
    callee: name,
    args: [receiver, arg, stream],
    type: cls === "TextEncoder" ? BYTES_U8 : STRING,
    loc,
  };
}

/** A direct construction of THE stdlib TextEncoder/TextDecoder, through
 * type-only wrappers. Name alone is never enough: a user class with the
 * same spelling keeps the ordinary class lowering. */
function directTextCodecCtorOf(lowerer: Lowerer, expr: ts.Expression): TextCodecCtor | null {
  const ctor = stripTypeCasts(expr);
  if (!ts.isNewExpression(ctor)) return null;
  const callee = stripTypeCasts(ctor.expression);
  if (!ts.isIdentifier(callee)) return null;
  if (callee.text !== "TextDecoder" && callee.text !== "TextEncoder") return null;
  const sym = lowerer.resolveValueSymbol(callee);
  if (!sym || !lowerer.isStdlibSymbol(sym)) return null;
  const name = ts.symbolName(sym);
  if (name !== "TextDecoder" && name !== "TextEncoder") return null;
  return { cls: name, ctor };
}

/** Inline codec calls avoid allocating a receiver; stored receivers use
 * the owned record path above. decode is the runtime's WHATWG
 * decode for every recognized static label (with BOM handling for the
 * Unicode encodings); a zero-argument decode() is "" like the spec's.
 * encode IS Buffer.from(s, "utf8") — both encode the string's UTF-8 with
 * each lone surrogate as U+FFFD, exactly what the spec's encoder emits.
 * Null when this is neither supported form. */
export function lowerTextCodecCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const member = access.name.text;
  if (
    member === "encodeInto" &&
    storedTextCodecClassOf(lowerer, access.expression) === "TextEncoder" &&
    lowerer.isStdlibMember(access)
  ) {
    if (call.arguments.nodes.length !== 2 || call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("TextEncoder.encodeInto with this argument shape", call);
    const loc = locOf(call);
    const receiver = lowerer.lowerExpr(access.expression);
    const result: IrExpr = {
      kind: "libCall",
      fn: "text.encodeInto",
      args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(stripTypeCasts(arg), DYN)),
      type: DYN,
      loc,
    };
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (!type) lowerer.badType(call, lowerer.typeOf(call));
    const checked = lowerer.coerceInto(call, result, type);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "exprStmt", expr: receiver, loc }],
      result: checked,
      type,
      loc,
    };
  }
  if (member !== "decode" && member !== "encode") return null;
  const info = directTextCodecCtorOf(lowerer, access.expression);
  if (info === null) return lowerStoredTextCodecCall(lowerer, call, access);
  if (!lowerer.isStdlibMember(access)) return null;
  const { cls, ctor: recv } = info;
  if (
    cls === "TextDecoder" &&
    ((recv.arguments?.nodes.length ?? 0) > 1 || call.arguments.nodes.length > 1)
  )
    return lowerStoredTextCodecCall(lowerer, call, access);
  if (
    !(cls === "TextDecoder" && member === "decode") &&
    !(cls === "TextEncoder" && member === "encode")
  ) {
    return null;
  }
  const loc = locOf(call);
  const ctorArgs = recv.arguments?.nodes ?? [];
  if (cls === "TextDecoder") {
    // The label must be statically known. A literal-typed effectful inline
    // expression is accepted, but its evaluation is sequenced before the
    // decode below, just as stored decoders evaluate it at construction.
    const labelT = ctorArgs.length >= 1 ? lowerer.typeOf(ctorArgs[0]!) : null;
    const encoding =
      ctorArgs.length === 0
        ? ({ kind: "utf8" } as const)
        : labelT !== null && labelT.isStringLiteralType()
          ? staticTextDecoderEncoding(labelT.value)
          : null;
    if (ctorArgs.length > 1 || encoding === null) {
      return lowerStoredTextCodecCall(lowerer, call, access);
    }
    const labelEffect =
      ctorArgs.length === 1 ? lowerer.lowerExprExpecting(ctorArgs[0]!, STRING) : null;
    const afterLabel = (result: IrExpr): IrExpr =>
      labelEffect === null || labelEffect.kind === "strLit"
        ? result
        : {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: labelEffect, loc: labelEffect.loc }],
            result,
            type: result.type,
            loc,
          };
    if (call.arguments.nodes.length === 0) {
      // decode() with no input is "" per spec — nothing to evaluate.
      return afterLabel({ kind: "strLit", value: "", type: STRING, loc });
    }
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(
        "decode with a stream option",
        call,
        "streaming decode has no lowering — decode whole buffers",
      );
    }
    const argNode = call.arguments.nodes[0]!;
    let arg = lowerDecodeInput(lowerer, argNode, loc);
    if (arg.type.kind === "dyn" || (arg.type.kind === "bytes" && arg.type.elem !== "u8")) {
      arg = {
        kind: "libCall",
        fn: "bytes.bufferSource",
        args: [lowerer.coerceInto(argNode, arg, DYN)],
        type: BYTES_U8,
        loc,
      };
    }
    if (!(arg.type.kind === "bytes" && arg.type.elem === "u8")) {
      lowerer.noLowering(
        `TextDecoder.decode of '${lowerer.fmt(arg.type)}' values`,
        argNode,
        "Uint8Array/Buffer input decodes (ArrayBuffer values have no representation)",
      );
    }
    const decoded: IrExpr =
      encoding.kind === "utf8"
        ? { kind: "libCall", fn: "text.decode", args: [arg], type: STRING, loc }
        : {
            kind: "libCall",
            fn: "text.decodeLegacy",
            args: [arg, { kind: "numLit", value: encoding.id, type: F64, loc }],
            type: STRING,
            loc,
          };
    return afterLabel(decoded);
  }
  if (ctorArgs.length > 0) {
    lowerer.noLowering("new TextEncoder with arguments", recv);
  }
  if (call.arguments.nodes.length > 1) {
    lowerer.noLowering(`TextEncoder.encode with ${call.arguments.nodes.length} arguments`, call);
  }
  const s =
    call.arguments.nodes.length === 0
      ? strLit("", loc)
      : lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
  const enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
  return { kind: "libCall", fn: "buffer.fromStr", args: [s, enc], type: BYTES_U8, loc };
}

export function lowerBufferEncodingCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering("buffer encoding call with spread arguments", expr);
  const arity = bi.member === "transcode" ? 3 : 1;
  const args = Array.from({ length: arity }, (_, index) =>
    expr.arguments.nodes[index]
      ? lowerer.lowerExprExpecting(stripTypeCasts(expr.arguments.nodes[index]!), DYN)
      : dynUndefinedExpr(loc),
  );
  if (expr.arguments.nodes.length > arity)
    lowerer.noLowering("buffer encoding call with extra arguments", expr);
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}
