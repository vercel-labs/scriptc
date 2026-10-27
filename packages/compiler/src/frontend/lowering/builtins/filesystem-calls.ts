import { dynUndefinedExpr, boolLit, numLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { lowerFsPath } from "./fs-paths.js";
import { isJsSourceFile, locOf } from "../../program.js";
import {
  type BuiltinModuleFn,
  FS_WRITE_FILE_DOCUMENTED_OPTIONS,
  fenceOrDropOptionKey,
} from "../surfaces.js";
import { voidizedCallback } from "../lower-server.js";
import { fsStreamCreateExpr } from "./fs-streams.js";
import {
  BYTES_U8,
  DYN,
  F64,
  FILEHANDLE_T,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  funcOf,
  typeEquals,
} from "../../../ir/ir.js";
import { lowerBuiltinOptionalDefault, optionMember, literalBoolOptions } from "./arguments.js";
import {
  lowerFsTimestampValue,
  lowerFsSyncBufferWindow,
  lowerStringOrBytesWrite,
} from "./filesystem.js";

export function lowerFsCallbackCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering("filesystem callback call with spread arguments", expr);
  const timestamp = ["utimes", "futimes", "lutimes"].includes(bi.member);
  const args: IrExpr = {
    kind: "dynArrLit",
    elems: expr.arguments.nodes.map((arg, index) =>
      timestamp && (index === 1 || index === 2)
        ? lowerFsTimestampValue(lowerer, arg, loc)
        : lowerer.lowerExprExpecting(arg, DYN),
    ),
    type: DYN,
    loc,
  };
  return {
    kind: "libCall",
    fn: "fs.callbackCall",
    args: [{ kind: "strLit", value: bi.member, type: STRING, loc }, args],
    type: DYN,
    loc,
  };
}

export function lowerFsLinkOrStatfsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
  name: string,
): IrExpr {
  const symbolic = bi.member === "symlinkSync" || bi.member === "symlink";
  const reading = bi.member === "readlinkSync" || bi.member === "readlink";
  const arity = symbolic ? 3 : 2;
  if (expr.arguments.nodes.length > arity || expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with this argument shape`, expr);
  const args = Array.from({ length: arity }, (_, index) =>
    expr.arguments.nodes[index]
      ? lowerer.lowerExprExpecting(expr.arguments.nodes[index]!, DYN)
      : dynUndefinedExpr(loc),
  );
  if (reading) {
    const promise = bi.module === "fs/promises";
    const result = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? fn.result;
    const inner = result.kind === "promise" ? result.inner : result;
    const bytes = inner.kind === "bytes";
    const text = inner.kind === "string";
    const selected = promise
      ? bytes
        ? "fsp.readlinkBuffer"
        : text
          ? "fsp.readlinkStr"
          : "fsp.readlink"
      : bytes
        ? "fs.readlinkSyncBuffer"
        : text
          ? "fs.readlinkSyncStr"
          : "fs.readlinkSync";
    const valueType = bytes ? BYTES_U8 : text ? STRING : DYN;
    return {
      kind: "libCall",
      fn: selected,
      args,
      type: promise ? { kind: "promise", inner: valueType } : valueType,
      loc,
    };
  }
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}

/** fs.cpSync / fs/promises cp: src, dest and the optional options cross
 * as dyn values (an omitted argument is undefined); scr_fs_cp_begin
 * validates them in Node's order. */
export function lowerFsCpCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  fn: BuiltinModuleFn,
  loc: SrcLoc,
  name: string,
): IrExpr {
  if (expr.arguments.nodes.length > 3 || expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with this argument shape`, expr);
  const args = [0, 1, 2].map((index) =>
    expr.arguments.nodes[index]
      ? lowerer.lowerExprExpecting(expr.arguments.nodes[index]!, DYN)
      : dynUndefinedExpr(loc),
  );
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}

export function lowerFsTimestampCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  fn: BuiltinModuleFn,
  loc: SrcLoc,
  name: string,
): IrExpr {
  if (expr.arguments.nodes.length > 3 || expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with this argument shape`, expr);
  const path = expr.arguments.nodes[0]
    ? lowerer.lowerExprExpecting(expr.arguments.nodes[0], DYN)
    : dynUndefinedExpr(loc);
  return {
    kind: "libCall",
    fn: fn.fn,
    args: [
      path,
      lowerFsTimestampValue(lowerer, expr.arguments.nodes[1], loc),
      lowerFsTimestampValue(lowerer, expr.arguments.nodes[2], loc),
    ],
    type: fn.result,
    loc,
  };
}

export function lowerFsVectorOrTruncateCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
  name: string,
): IrExpr {
  const vector = bi.member !== "ftruncateSync";
  const required = vector ? 2 : 1;
  if (
    expr.arguments.nodes.length < required ||
    expr.arguments.nodes.length > required + 1 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  )
    lowerer.noLowering(`${name} with this argument shape`, expr);
  const args = [lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64)];
  if (vector) args.push(lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, arrayOf(BYTES_U8)));
  const optional = expr.arguments.nodes[required];
  args.push(
    optional
      ? lowerBuiltinOptionalDefault(lowerer, optional, F64, numLit(vector ? -1 : 0, loc), vector)
      : numLit(vector ? -1 : 0, loc),
  );
  return { kind: "libCall", fn: fn.fn, args, type: vector ? F64 : VOID, loc };
}

// Numeric open flags are interpreted symbolically at the call site. The
// O_* bit values differ between Darwin and Linux, so emit a stable mask
// and let the target runtime select its own native constants.
export function lowerFsNumericOpenCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.length > 3 || expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering("openSync with numeric flags and this argument shape", expr);
  }
  const bits: Record<string, number | undefined> = {
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 4,
    O_EXCL: 8,
    O_NOFOLLOW: 16,
    O_NONBLOCK: 32,
    O_TRUNC: 64,
    O_APPEND: 128,
  };
  const flagsOf = (input: ts.Expression): number | null => {
    let node = input;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarToken) {
      const left = flagsOf(node.left);
      const right = flagsOf(node.right);
      return left === null || right === null ? null : left | right;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = lowerer.builtinImportOf(node.expression);
      if (imported?.module === "fs" && imported.member === "constants") {
        return bits[node.name.text] ?? null;
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const imported = lowerer.builtinMemberOf(node.expression);
      if (imported?.module === "fs" && imported.member === "constants") {
        return bits[node.name.text] ?? null;
      }
    }
    return null;
  };
  const mask = flagsOf(expr.arguments.nodes[1]!);
  if (mask === null) {
    lowerer.noLowering(
      "openSync with computed numeric flags",
      expr.arguments.nodes[1]!,
      "use an inline bitwise OR of fs.constants.O_RDONLY/O_WRONLY/O_RDWR/O_CREAT/O_EXCL/O_NOFOLLOW/O_NONBLOCK/O_TRUNC/O_APPEND",
    );
  }
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const mode = expr.arguments.nodes[2]
    ? lowerer.lowerExprExpecting(expr.arguments.nodes[2]!, F64)
    : ({ kind: "numLit", value: 0o666, type: F64, loc } satisfies IrExpr);
  return {
    kind: "libCall",
    fn: "fs.openNumericSync",
    args: [path, { kind: "numLit", value: mask, type: F64, loc }, mode],
    type: F64,
    loc,
  };
}

// fs/promises.open(path[, flags[, mode]]) — string flags and numeric
// creation mode, with Node's "r"/0o666 defaults. The runtime wraps
// the descriptor in a shared FileHandle and settles/rejects exactly
// like the existing fs/promises operations.
export function lowerFsPromisesOpenCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (
    expr.arguments.nodes.length < 1 ||
    expr.arguments.nodes.length > 3 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `fs.promises.open with ${expr.arguments.nodes.length} arguments`,
      expr,
      "use open(path[, stringFlags[, numericMode]])",
    );
  }
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const defaultFlags: IrExpr = { kind: "strLit", value: "r", type: STRING, loc };
  const defaultMode: IrExpr = { kind: "numLit", value: 0o666, type: F64, loc };
  const flags = expr.arguments.nodes[1]
    ? lowerBuiltinOptionalDefault(lowerer, expr.arguments.nodes[1]!, STRING, defaultFlags)
    : defaultFlags;
  const mode = expr.arguments.nodes[2]
    ? lowerBuiltinOptionalDefault(lowerer, expr.arguments.nodes[2]!, F64, defaultMode)
    : defaultMode;
  return {
    kind: "libCall",
    fn: "fsp.open",
    args: [path, flags, mode],
    type: { kind: "promise", inner: FILEHANDLE_T },
    loc,
  };
}

// fs.rename(oldPath, newPath, callback): the callback is a
// program-shaped closure (zero parameters are valid; the ordinary
// form receives NodeJS.ErrnoException | null). Keep it typed here so
// the backends can emit the same union-building adapter used by
// dns.lookup instead of losing the Error arm through a dyn boundary.
export function lowerFsRenameCallbackCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.length !== 3 || expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `rename with ${expr.arguments.nodes.length} argument${expr.arguments.nodes.length === 1 ? "" : "s"}`,
      expr,
      "the supported form is rename(oldPath, newPath, callback)",
    );
  }
  const oldPath = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  const newPath = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, STRING);
  let callback = lowerer.lowerExpr(expr.arguments.nodes[2]!);
  // JS/checkJs callback values may arrive as checked-dynamic callables.
  // Adapt them to the one error-first slot; the runtime passes a dyn
  // Error on failure and null on success through the emitted thunk.
  if (callback.type.kind === "dyn") {
    callback = {
      kind: "dynCheck",
      value: callback,
      type: funcOf([DYN], VOID),
      loc: locOf(expr.arguments.nodes[2]!),
    };
  }
  let callbackOk = callback.type.kind === "func" && callback.type.params.length <= 1;
  if (callbackOk && callback.type.kind === "func" && callback.type.params.length === 1) {
    const param = callback.type.params[0]!;
    if (param.kind === "dyn") {
      callbackOk = true;
    } else if (param.kind === "union") {
      const def = lowerer.unions.get(param.unionId);
      callbackOk =
        !!def &&
        def.arms.some((a) => a.kind === "nullT") &&
        def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
        def.arms.every(
          (a) =>
            a.kind === "nullT" ||
            a.kind === "undefinedT" ||
            (a.kind === "object" && a.className === "%Error"),
        );
    } else {
      callbackOk = false;
    }
  }
  if (!callbackOk) {
    lowerer.unsupported(
      "SC1090",
      expr.arguments.nodes[2]!,
      "fs.rename callbacks must accept at most one Error | null parameter",
    );
  }
  // TypeScript deliberately permits a value-returning function where a
  // void callback is expected; Node ignores that value. Normalize the
  // closure to the runtime's void callback ABI after validating its
  // error-first parameter shape.
  callback = voidizedCallback(lowerer, callback, locOf(expr.arguments.nodes[2]!));
  return {
    kind: "libCall",
    fn: "fs.renameCb",
    args: [oldPath, newPath, callback],
    type: VOID,
    loc,
  };
}

// fs.readSync's classic and options-object buffer forms normalize into
// one fixed-width IR call. Current-offset forms use Node/libuv's -1
// sentinel; a numeric position performs offset-preserving I/O.
export function lowerFsReadSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const supported =
    "use readSync(fd, buffer), readSync(fd, buffer, { offset?, length?, position? }), or readSync(fd, buffer, offset, length[, position]); bigint positions and non-literal options objects have no lowering";
  if (
    expr.arguments.nodes.length < 2 ||
    expr.arguments.nodes.length > 5 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      `readSync with ${expr.arguments.nodes.length} argument${expr.arguments.nodes.length === 1 ? "" : "s"}`,
      expr,
      supported,
    );
  }
  if (expr.arguments.nodes.length === 2) {
    return lowerFsSyncBufferWindow(
      lowerer,
      expr,
      loc,
      "fs.readSync",
      { kind: "options", node: undefined },
      supported,
    );
  }
  if (expr.arguments.nodes.length === 3) {
    const optionsNode = expr.arguments.nodes[2]!;
    let valueNode = optionsNode;
    while (ts.isParenthesizedExpression(valueNode)) valueNode = valueNode.expression;
    if (ts.isObjectLiteralExpression(valueNode) || valueNode.kind === ts.SyntaxKind.NullKeyword) {
      return lowerFsSyncBufferWindow(
        lowerer,
        expr,
        loc,
        "fs.readSync",
        { kind: "options", node: valueNode },
        supported,
      );
    }
    lowerer.noLowering("readSync with a non-literal options argument", optionsNode, supported);
  }
  // JavaScript arguments outside the typed signature (an untyped fd or
  // buffer, a bigint or untyped position) take Node's argument checks at
  // run time, then the same read.
  if (isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const nodes = expr.arguments.nodes;
    const typed = [F64, BYTES_U8, F64, F64, F64].every((want, i) => {
      const node = nodes[i];
      if (node === undefined) return true;
      let value: ts.Expression = node;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (i === 4 && value.kind === ts.SyntaxKind.NullKeyword) return true;
      const t = lowerer.mapTypeOf(lowerer.typeOf(node));
      return t !== null && (want.kind === "bytes" ? t.kind === "bytes" : t.kind === "f64");
    });
    if (!typed) {
      const args = [0, 1, 2, 3, 4].map((i): IrExpr => {
        const node = nodes[i];
        return node === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(node, DYN);
      });
      return { kind: "libCall", fn: "fs.readSyncDyn", args, type: F64, loc };
    }
  }
  const args: IrExpr[] = [
    lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64),
    lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, BYTES_U8),
    lowerer.lowerExprExpecting(expr.arguments.nodes[2]!, F64),
    lowerer.lowerExprExpecting(expr.arguments.nodes[3]!, F64),
  ];
  const positionNode = expr.arguments.nodes[4];
  let positionValueNode = positionNode;
  while (positionValueNode && ts.isParenthesizedExpression(positionValueNode)) {
    positionValueNode = positionValueNode.expression;
  }
  if (positionNode === undefined || positionValueNode!.kind === ts.SyntaxKind.NullKeyword) {
    args.push({ kind: "numLit", value: -1, type: F64, loc });
  } else {
    const positionType = lowerer.mapTypeOf(lowerer.typeOf(positionNode));
    if (positionType?.kind !== "f64") {
      lowerer.noLowering(
        `readSync with a '${positionType ? lowerer.fmt(positionType) : lowerer.checker.typeToString(lowerer.typeOf(positionNode))}' position`,
        positionNode,
        supported,
      );
    }
    args.push(lowerer.lowerExprExpecting(positionNode, F64));
  }
  return { kind: "libCall", fn: "fs.readSync", args, type: F64, loc };
}

// fs.writeSync has buffer and string families. Buffer writes accept
// omitted offset/length and inline options; string writes accept
// (fd, string[, position[, "utf8"]]). The runtime uses -1 for current
// offset. Invalid numeric WRITE positions intentionally reach the
// runtime, where Node normalizes them to the current descriptor offset.
export function lowerFsWriteSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const supported =
    'use writeSync(fd, buffer[, offset[, length[, position]]]), writeSync(fd, buffer, { offset?, length?, position? }), or writeSync(fd, string[, position[, "utf8"]]); non-literal options objects, bigint positions, and other encodings have no lowering';
  if (expr.arguments.nodes.some(ts.isSpreadElement) || expr.arguments.nodes.length < 2) {
    lowerer.noLowering(
      `writeSync with ${expr.arguments.nodes.length} argument${expr.arguments.nodes.length === 1 ? "" : "s"}`,
      expr,
      supported,
    );
  }
  const dataNode = expr.arguments.nodes[1]!;
  const dataType = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
  const position = (node: ts.Expression | undefined): IrExpr => {
    let valueNode = node;
    while (valueNode && ts.isParenthesizedExpression(valueNode)) valueNode = valueNode.expression;
    if (node === undefined || valueNode!.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: "numLit", value: -1, type: F64, loc };
    }
    const t = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (t?.kind !== "f64") {
      lowerer.noLowering(
        `writeSync with a '${t ? lowerer.fmt(t) : lowerer.checker.typeToString(lowerer.typeOf(node))}' position`,
        node,
        supported,
      );
    }
    return lowerer.lowerExprExpecting(node, F64);
  };
  if (dataType?.kind === "bytes") {
    if (dataType.elem !== "u8") {
      lowerer.noLowering(
        `writeSync of '${lowerer.fmt(dataType)}' data`,
        dataNode,
        "byte writes take Uint8Array/Buffer data",
      );
    }
    if (expr.arguments.nodes.length === 2) {
      return lowerFsSyncBufferWindow(
        lowerer,
        expr,
        loc,
        "fs.writeSync",
        { kind: "options", node: undefined },
        supported,
      );
    }
    if (expr.arguments.nodes.length === 3) {
      const thirdNode = expr.arguments.nodes[2]!;
      let valueNode = thirdNode;
      while (ts.isParenthesizedExpression(valueNode)) valueNode = valueNode.expression;
      if (ts.isObjectLiteralExpression(valueNode) || valueNode.kind === ts.SyntaxKind.NullKeyword) {
        return lowerFsSyncBufferWindow(
          lowerer,
          expr,
          loc,
          "fs.writeSync",
          { kind: "options", node: valueNode },
          supported,
        );
      }
      if (lowerer.mapTypeOf(lowerer.typeOf(thirdNode))?.kind === "f64") {
        return lowerFsSyncBufferWindow(
          lowerer,
          expr,
          loc,
          "fs.writeSync",
          { kind: "offset", node: thirdNode },
          supported,
        );
      }
      lowerer.noLowering(
        "writeSync of Buffer data with a non-numeric offset",
        thirdNode,
        supported,
      );
    }
    if (expr.arguments.nodes.length !== 4 && expr.arguments.nodes.length !== 5) {
      lowerer.noLowering(
        `writeSync of Buffer data with ${expr.arguments.nodes.length} arguments`,
        expr,
        supported,
      );
    }
    const fd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64);
    return {
      kind: "libCall",
      fn: "fs.writeSync",
      args: [
        fd,
        lowerer.lowerExprExpecting(dataNode, BYTES_U8),
        lowerer.lowerExprExpecting(expr.arguments.nodes[2]!, F64),
        lowerer.lowerExprExpecting(expr.arguments.nodes[3]!, F64),
        position(expr.arguments.nodes[4]),
      ],
      type: F64,
      loc,
    };
  }
  if (dataType?.kind === "string") {
    if (expr.arguments.nodes.length > 4) {
      lowerer.noLowering(
        `writeSync of string data with ${expr.arguments.nodes.length} arguments`,
        expr,
        supported,
      );
    }
    const encNode = expr.arguments.nodes[3];
    let enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
    if (encNode !== undefined) {
      const encType = lowerer.typeOf(encNode);
      if (
        !encType.isStringLiteralType() ||
        (encType.value !== "utf8" && encType.value !== "utf-8")
      ) {
        lowerer.noLowering("writeSync with a non-utf8 encoding", encNode, supported);
      }
      // Even though utf8 is the runtime's only encoding, the argument
      // remains an ordinary JS argument: evaluate it in source order so
      // a call/getter whose type is the accepted literal cannot vanish.
      enc = lowerer.lowerExprExpecting(encNode, STRING);
    }
    const fd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64);
    return {
      kind: "libCall",
      fn: "fs.writeStrSync",
      args: [
        fd,
        lowerer.lowerExprExpecting(dataNode, STRING),
        position(expr.arguments.nodes[2]),
        enc,
      ],
      type: F64,
      loc,
    };
  }
  lowerer.noLowering(
    `writeSync of '${dataType ? lowerer.fmt(dataType) : lowerer.checker.typeToString(lowerer.typeOf(dataNode))}' data`,
    dataNode,
    supported,
  );
}

// The readFileSync(fd[, "utf8"]) forms — Node accepts a file
// descriptor where it accepts a path (the stdin pattern:
// readFileSync(0, "utf8")). Routed by the ARGUMENT's static type,
// like fileURLToPath. Encoding-bearing reads use the shared decoder above;
// this fallback retains the existing Buffer and utf8 forms.
export function lowerFsReadDescriptorCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const fd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64);
  if (expr.arguments.nodes.length === 1) {
    return { kind: "libCall", fn: "fs.readFdSyncBytes", args: [fd], type: BYTES_U8, loc };
  }
  const encT = lowerer.typeOf(expr.arguments.nodes[1]!);
  if (
    expr.arguments.nodes.length !== 2 ||
    !(encT.isStringLiteralType() && (encT.value === "utf8" || encT.value === "utf-8"))
  ) {
    lowerer.noLowering(
      `readFileSync(fd) with a non-"utf8" encoding`,
      expr.arguments.nodes[1] ?? expr,
      'only utf8 reads are supported: readFileSync(fd, "utf8")',
    );
  }
  const enc = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, STRING);
  return { kind: "libCall", fn: "fs.readFdSync", args: [fd, enc], type: STRING, loc };
}

/** The `{ encoding }` options record. A literal whose value is checked-
 * dynamic (an encoding variable reassigned from an untyped source) lowers
 * to a dynamic object: check it into the record the checker describes. */
function encodingOptions(lowerer: Lowerer, options: ts.Expression, type: IrType): IrExpr {
  const value = lowerer.lowerExpr(options);
  return typeEquals(value.type, type) ? value : lowerer.coerceInto(options, value, type);
}

/** Encoding-bearing reads share Buffer's decoder and runtime alias checks.
 * Keep the read and encoding evaluation in source order in one helper. */
export function lowerFsEncodedRead(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  descriptor: boolean,
  loc: SrcLoc,
): IrExpr | null {
  if (expr.arguments.nodes.length !== 2 || expr.arguments.nodes.some(ts.isSpreadElement))
    return null;
  const options = expr.arguments.nodes[1]!;
  const optionsType = lowerer.mapTypeOf(lowerer.typeOf(options));
  if (optionsType?.kind !== "string" && optionsType?.kind !== "record") return null;
  if (optionsType.kind === "record") {
    const fields = lowerer.shapes.get(optionsType.shapeId)?.fields;
    if (
      !fields ||
      fields.find((entry) => entry.name === "encoding")?.type.kind !== "string" ||
      fields.some((entry) => entry.name !== "encoding")
    )
      return null;
  }
  const sourceType = descriptor ? F64 : STRING;
  const source = descriptor
    ? lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, sourceType)
    : lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const encoding: IrExpr =
    optionsType.kind === "string"
      ? lowerer.lowerExprExpecting(options, STRING)
      : {
          kind: "recordGet",
          obj: encodingOptions(lowerer, options, optionsType),
          shapeId: optionsType.shapeId,
          field: "encoding",
          type: STRING,
          loc,
        };
  // Empty encodings return a Buffer, and unknown string spellings may
  // throw. Keep the runtime result when the selected overload admits both
  // strings and Buffers rather than promising a string from its argument.
  if (!descriptor && lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind !== "string")
    return {
      kind: "libCall",
      fn: "fs.readFileSyncDyn",
      args: [source, lowerer.coerceToExpected(encoding, DYN)],
      type: DYN,
      loc,
    };
  return {
    kind: "libCall",
    fn: descriptor ? "fs.readFdEncoded" : "fs.readFileEncoded",
    args: [source, encoding],
    type: STRING,
    loc,
  };
}

/** fs.promises.readFile(path, encoding | { encoding }) when its result is a
 * Promise<string>: the runtime checks the name and decodes, as
 * readFileSync's encoded read does. Null for other shapes. */
export function lowerFsPromisesEncodedRead(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (expr.arguments.nodes.length !== 2 || expr.arguments.nodes.some(ts.isSpreadElement))
    return null;
  const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (result?.kind !== "promise" || result.inner.kind !== "string") return null;
  const options = expr.arguments.nodes[1]!;
  const optionsTsType = lowerer.typeOf(options);
  if (
    optionsTsType.isStringLiteralType() &&
    (optionsTsType.value === "utf8" || optionsTsType.value === "utf-8")
  )
    return null;
  const optionsType = lowerer.mapTypeOf(optionsTsType);
  if (optionsType?.kind !== "string" && optionsType?.kind !== "record") return null;
  if (optionsType.kind === "record") {
    const fields = lowerer.shapes.get(optionsType.shapeId)?.fields;
    if (
      !fields ||
      fields.find((entry) => entry.name === "encoding")?.type.kind !== "string" ||
      fields.some((entry) => entry.name !== "encoding")
    )
      return null;
  }
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const encoding: IrExpr =
    optionsType.kind === "string"
      ? lowerer.lowerExprExpecting(options, STRING)
      : {
          kind: "recordGet",
          obj: encodingOptions(lowerer, options, optionsType),
          shapeId: optionsType.shapeId,
          field: "encoding",
          type: STRING,
          loc,
        };
  return {
    kind: "libCall",
    fn: "fsp.readFileEncoded",
    args: [path, encoding],
    type: { kind: "promise", inner: STRING },
    loc,
  };
}

/** opendirSync(path[, options]) and fs.promises.opendir: the options are a
 * literal `{ bufferSize?: <number>, encoding?: "utf8" }`. bufferSize
 * defaults to Node's 32 and is checked by the runtime after the directory
 * opens, as Node's Dir constructor does; other options (recursive, other
 * encodings) have no lowering. */
export function lowerFsOpendirCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  fn: BuiltinModuleFn,
  member: string,
  loc: SrcLoc,
): IrExpr {
  if (
    expr.arguments.nodes.length < 1 ||
    expr.arguments.nodes.length > 2 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(`${member} with ${expr.arguments.nodes.length} arguments`, expr);
  }
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  let bufferSize: IrExpr = { kind: "numLit", value: 32, type: F64, loc };
  const optsNode = expr.arguments.nodes[1];
  if (optsNode && !(ts.isIdentifier(optsNode) && optsNode.text === "undefined")) {
    const fence = (): never =>
      lowerer.noLowering(
        `${member} options beyond { bufferSize, encoding: "utf8" }`,
        optsNode,
        "pass an object literal with a numeric bufferSize and a utf8 encoding; recursive walks and other encodings have no lowering",
      );
    if (!ts.isObjectLiteralExpression(optsNode)) fence();
    for (const property of (optsNode as ts.ObjectLiteralExpression).properties.nodes) {
      const option = optionMember(property);
      if (!option) fence();
      else if (option.name === "bufferSize")
        bufferSize = lowerer.lowerExprExpecting(option.value, F64);
      else if (option.name === "encoding") {
        const encoding = lowerer.typeOf(option.value);
        if (
          !(
            encoding.isStringLiteralType() &&
            (encoding.value === "utf8" || encoding.value === "utf-8")
          )
        )
          fence();
      } else fence();
    }
  }
  return { kind: "libCall", fn: fn.fn, args: [path, bufferSize], type: fn.result, loc };
}

/** fs.createReadStream / fs.createWriteStream(path[, options]). */
export function lowerFsStreamCreate(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: "createReadStream" | "createWriteStream",
  loc: SrcLoc,
): IrExpr {
  return fsStreamCreateExpr(
    lowerer,
    expr.arguments.nodes,
    member === "createReadStream",
    `fs.${member}`,
    expr,
    loc,
  );
}

// mkdirSync(p, options): the lowered options form is a literal
// `{ recursive?: <boolean literal>, mode?: <number> }` — recursive:
// true routes to Node's recursive algorithm (the mode, when present,
// applies to every directory the walk creates, like Node's), false/
// absent is the plain mkdir. The recursive form's return value (the
// first created directory, `string | undefined` under @types/node)
// has no lowering — statement position only.
export function lowerFsMkdirSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const optsNode = expr.arguments.nodes[1]!;
  const options = parseMkdirOptions(optsNode);
  if (!options) {
    lowerer.noLowering(
      "mkdirSync with an options argument beyond { recursive, mode }",
      optsNode,
      "the recursive flag must be a boolean literal and mode a number; other options have no lowering",
    );
  }
  const { recursive, modeNode } = options;
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const mode: IrExpr | null = modeNode ? lowerer.lowerExprExpecting(modeNode, F64) : null;
  if (!recursive) {
    return mode
      ? { kind: "libCall", fn: "fs.mkdirModeSync", args: [path, mode], type: VOID, loc }
      : { kind: "libCall", fn: "fs.mkdirSync", args: [path], type: VOID, loc };
  }
  if (!ts.isExpressionStatement(expr.parent)) {
    lowerer.noLowering(
      "mkdirSync's return value in the recursive form",
      expr,
      "the first-created-directory result has no lowering — call it as a statement",
    );
  }
  return mode
    ? { kind: "libCall", fn: "fs.mkdirRecursiveModeSync", args: [path, mode], type: VOID, loc }
    : { kind: "libCall", fn: "fs.mkdirRecursiveSync", args: [path], type: VOID, loc };
}

// fs.promises.mkdir(p, options): the mkdirSync matrix behind settled
// promises — literal { recursive?: <boolean literal>, mode?: number }.
// The recursive form's value (`string | undefined`) has no lowering;
// `await` in statement position is the supported use.
export function lowerFsPromisesMkdirCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const optsNode = expr.arguments.nodes[1]!;
  const options = parseMkdirOptions(optsNode);
  if (!options) {
    lowerer.noLowering(
      "fs.promises.mkdir with an options argument beyond { recursive, mode }",
      optsNode,
      "the recursive flag must be a boolean literal and mode a number; other options have no lowering",
    );
  }
  const { recursive, modeNode } = options;
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const mode: IrExpr | null = modeNode ? lowerer.lowerExprExpecting(modeNode, F64) : null;
  const type: IrType = { kind: "promise", inner: VOID };
  if (!recursive) {
    return mode
      ? { kind: "libCall", fn: "fsp.mkdirMode", args: [path, mode], type, loc }
      : { kind: "libCall", fn: "fsp.mkdir", args: [path], type, loc };
  }
  return mode
    ? { kind: "libCall", fn: "fsp.mkdirRecursiveMode", args: [path, mode], type, loc }
    : { kind: "libCall", fn: "fsp.mkdirRecursive", args: [path], type, loc };
}

// rmSync(p, options) and fs.promises.rm(p, options): literal
// { recursive?, force? } booleans — the cleanup shape
// rmSync(dir, { recursive: true, force: true }) — plus the
// maxRetries/retryDelay numbers (the tmpdir-harness shape
// rmSync(p, { maxRetries: 3, recursive: true, force: true })): those
// lower as ordinary number expressions into the retry libCall, whose
// runtime implements Node's linear-backoff retry on
// EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM. The retry-free shape keeps the
// historical rmOptsSync lowering unchanged. The promise form runs the same
// removal and rejects with its error.
export function lowerFsRemoveCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  promise: boolean,
): IrExpr {
  const opts = literalBoolOptions(
    expr.arguments.nodes[1]!,
    ["recursive", "force"],
    ["maxRetries", "retryDelay"],
  );
  if (opts === null) {
    lowerer.noLowering(
      `${promise ? "fs.promises.rm" : "rmSync"} with an options argument beyond { recursive, force, maxRetries, retryDelay }`,
      expr.arguments.nodes[1]!,
      "the recursive/force flags must be boolean literals; maxRetries/retryDelay are numbers; other options have no lowering",
    );
  }
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);

  const recursive = boolLit(opts.bools["recursive"] === true, loc);
  const force = boolLit(opts.bools["force"] === true, loc);
  const type: IrType = promise ? { kind: "promise", inner: VOID } : VOID;
  if (opts.exprs["maxRetries"] === undefined && opts.exprs["retryDelay"] === undefined) {
    return {
      kind: "libCall",
      fn: promise ? "fsp.rmOpts" : "fs.rmOptsSync",
      args: [path, recursive, force],
      type,
      loc,
    };
  }
  // Node's defaults: maxRetries 0, retryDelay 100 (only reached when
  // at least one of the pair is spelled — the plain form above owns
  // the both-omitted case).
  const num = (node: ts.Expression | undefined, dflt: number): IrExpr =>
    node ? lowerer.lowerExprExpecting(node, F64) : { kind: "numLit", value: dflt, type: F64, loc };
  return {
    kind: "libCall",
    fn: promise ? "fsp.rmRetry" : "fs.rmRetrySync",
    args: [
      path,
      recursive,
      force,
      num(opts.exprs["maxRetries"], 0),
      num(opts.exprs["retryDelay"], 100),
    ],
    type,
    loc,
  };
}

export function lowerFsWriteBytesCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!));
  if (dataIr?.kind === "union") {
    const arms = lowerer.unions.get(dataIr.unionId)?.arms;
    if (
      arms &&
      arms.every((arm) => arm.kind === "string" || (arm.kind === "bytes" && arm.elem === "u8"))
    ) {
      return lowerStringOrBytesWrite(lowerer, expr, dataIr, arms, bi.member === "appendFileSync");
    }
  }
  if (dataIr?.kind === "bytes") {
    if (dataIr.elem !== "u8") {
      lowerer.noLowering(
        `${bi.member} of '${lowerer.fmt(dataIr)}' data`,
        expr.arguments.nodes[1]!,
        "byte writes take Uint8Array/Buffer data",
      );
    }
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
    const data = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, BYTES_U8);
    if (bi.module === "fs/promises") {
      return {
        kind: "libCall",
        fn: "fsp.appendFileBytes",
        args: [path, data],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: bi.member === "appendFileSync" ? "fs.appendFileSyncBytes" : "fs.writeFileSyncBytes",
      args: [path, data],
      type: VOID,
      loc,
    };
  }

  return null;
}

export function lowerFsWriteOptionsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  promiseWriteOptions: boolean,
): IrExpr {
  const optsNode = expr.arguments.nodes[2]!;
  const operation = promiseWriteOptions ? "fs.promises.writeFile" : "writeFileSync";
  const plainFn: IrLibFn = promiseWriteOptions ? "fsp.writeFile" : "fs.writeFileSync";
  const modeFn: IrLibFn = promiseWriteOptions ? "fsp.writeFileMode" : "fs.writeFileModeSync";
  const resultType: IrType = promiseWriteOptions ? { kind: "promise", inner: VOID } : VOID;
  type WriteOptionValue = { kind: "effect" | "mode"; value: IrExpr };
  // The runtime needs only `mode`, but every source option value is an
  // ordinary JS expression. Stage path/data and then evaluate the option
  // values in object-literal order before issuing the write; otherwise a
  // call/getter statically typed as the accepted utf8 literal can vanish.
  const finishWrite = (optionValues: WriteOptionValue[]): IrExpr => {
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
    const data = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, STRING);
    const pathLocal = lowerer.declareHiddenLocal("%writePath", STRING);
    const dataLocal = lowerer.declareHiddenLocal("%writeData", STRING);
    const stmts: IrStmt[] = [
      { kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc },
      { kind: "varDecl", localId: dataLocal.id, init: data, loc: data.loc },
    ];
    let mode: IrExpr | null = null;
    for (const option of optionValues) {
      if (option.kind === "effect") {
        stmts.push({ kind: "exprStmt", expr: option.value, loc: option.value.loc });
        continue;
      }
      const modeLocal = lowerer.declareHiddenLocal("%writeMode", F64);
      stmts.push({
        kind: "varDecl",
        localId: modeLocal.id,
        init: option.value,
        loc: option.value.loc,
      });
      mode = varRef(modeLocal.id, modeLocal.type, loc);
    }
    const result: IrExpr = {
      kind: "libCall",
      fn: mode ? modeFn : plainFn,
      args: mode
        ? [
            varRef(pathLocal.id, pathLocal.type, loc),
            varRef(dataLocal.id, dataLocal.type, loc),
            mode,
          ]
        : [varRef(pathLocal.id, pathLocal.type, loc), varRef(dataLocal.id, dataLocal.type, loc)],
      type: resultType,
      loc,
    };
    return { kind: "seqExpr", stmts, result, type: resultType, loc };
  };
  // The bare-encoding spelling — writeFileSync(p, data, "utf-8") — is
  // the options record's encoding key alone: utf8 is what the runtime
  // writes anyway, so string data takes the plain write. Any OTHER
  // encoding name changes bytes and keeps the fence below.
  {
    const t = lowerer.typeOf(optsNode);
    if (
      t.isStringLiteralType() &&
      (t.value === "utf8" || t.value === "utf-8") &&
      lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!))?.kind === "string"
    ) {
      return finishWrite([{ kind: "effect", value: lowerer.lowerExprExpecting(optsNode, STRING) }]);
    }
  }
  const optionValues: WriteOptionValue[] = [];
  let ok = ts.isObjectLiteralExpression(optsNode);
  if (ok) {
    for (const p of (optsNode as ts.ObjectLiteralExpression).properties.nodes) {
      const m = optionMember(p);
      if (!m) {
        ok = false;
        break;
      }
      if (m.name === "mode") {
        optionValues.push({ kind: "mode", value: lowerer.lowerExprExpecting(m.value, F64) });
      } else if (m.name === "encoding") {
        const t = lowerer.typeOf(m.value);
        if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
          ok = false;
          break;
        }
        optionValues.push({ kind: "effect", value: lowerer.lowerExprExpecting(m.value, STRING) });
      } else if (m.name === "flag") {
        // Documented, behavior-changing (open(2)'s disposition — 'a'
        // IS appendFileSync), no lowering: fence by name.
        lowerer.noLowering(
          `${operation} with the flag option`,
          p,
          "the write truncates-or-creates (Node's default 'w'); other flags have no lowering",
        );
      } else {
        // The options-record stance: documented keys with no lowering
        // fence by name; undocumented keys drop like Node.
        fenceOrDropOptionKey(
          lowerer,
          p,
          m.name,
          operation,
          FS_WRITE_FILE_DOCUMENTED_OPTIONS,
          'the supported options are { mode: <number>, encoding: "utf8" }',
        );
      }
    }
  }
  if (!ok || lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!))?.kind !== "string") {
    lowerer.noLowering(
      `${operation} with 3 arguments`,
      optsNode,
      'the supported options are { mode: <number>, encoding: "utf8" } over string data',
    );
  }
  return finishWrite(optionValues);
}

export function lowerFsReadPathCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  // The path-form Buffer read and the runtime-encoding dispatch
  // (test/common fixtures.js's readFixtureKey(name, enc) — BOTH the
  // path and the encoding are untyped JS values there: the path is
  // fixturesPath(...)'s checker-any, so the LOWERED kind decides and
  // a dyn path rides a validated string extraction — Node's
  // non-string paths throw ERR_INVALID_ARG_TYPE where the dynCheck
  // throws its path-annotated TypeError. The fd forms (a number
  // argument) and literal-utf8 reads keep their existing lowerings.
  const pathV = lowerer.lowerExpr(expr.arguments.nodes[0]!);
  if (pathV.type.kind === "string" || pathV.type.kind === "dyn") {
    const pathArg: IrExpr =
      pathV.type.kind === "dyn" ? { kind: "dynCheck", value: pathV, type: STRING, loc } : pathV;
    if (expr.arguments.nodes.length === 1) {
      return { kind: "libCall", fn: "fs.readFileSyncBuf", args: [pathArg], type: BYTES_U8, loc };
    }
    // Runtime nullish and empty encodings read Buffers, supported names
    // read strings, and invalid names throw ERR_INVALID_ARG_VALUE. A
    // non-dyn encoding falls through to the literal-utf8 lowering
    // below (the discarded probe IR never emits).
    const encT = lowerer.typeOf(expr.arguments.nodes[1]!);
    if (!(encT.isStringLiteralType() && (encT.value === "utf8" || encT.value === "utf-8"))) {
      const enc = lowerer.lowerExpr(expr.arguments.nodes[1]!);
      if (enc.type.kind === "dyn") {
        return {
          kind: "libCall",
          fn: "fs.readFileSyncDyn",
          args: [pathArg, enc],
          type: DYN,
          loc,
        };
      }
    }
  }

  return null;
}

/** Both mkdir forms accept the same literal option shape; evaluation stays in the caller. */
function parseMkdirOptions(
  node: ts.Expression,
): { recursive: boolean; modeNode: ts.Expression | null } | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  let recursive = false;
  let modeNode: ts.Expression | null = null;
  for (const property of node.properties.nodes) {
    const member = optionMember(property);
    if (!member) return null;
    if (member.name === "recursive") {
      if (member.value.kind === ts.SyntaxKind.TrueKeyword) recursive = true;
      else if (member.value.kind === ts.SyntaxKind.FalseKeyword) recursive = false;
      else return null;
    } else if (member.name === "mode") {
      modeNode = member.value;
    } else {
      return null;
    }
  }
  return { recursive, modeNode };
}
