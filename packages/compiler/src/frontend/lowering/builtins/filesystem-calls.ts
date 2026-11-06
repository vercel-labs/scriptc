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
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  FILEHANDLE_T,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  funcOf,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { InternalCompilerError } from "../../../errors.js";
import {
  lowerBuiltinOptionalDefault,
  optionMember,
  literalBoolOptions,
  stripTypeCasts,
} from "./arguments.js";
import { constInitializerOf } from "../lower-exprs.js";
import {
  fsWriteFdLibFn,
  fsWriteLibFn,
  lowerFsTimestampValue,
  lowerFsSyncBufferWindow,
  lowerStringOrBytesWrite,
  lowerStringOrBytesWriteFd,
  type WriteFdFamily,
  type WriteFamily,
  type WriteOptions,
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
  const defaultMode: IrExpr = { kind: "numLit", value: 0o666, type: F64, loc };
  // Node treats an undefined creation mode as an omitted one.
  const mode = expr.arguments.nodes[2]
    ? lowerBuiltinOptionalDefault(lowerer, expr.arguments.nodes[2]!, F64, defaultMode)
    : defaultMode;
  return {
    kind: "libCall",
    fn: "fs.openNumericSync",
    args: [path, { kind: "numLit", value: mask, type: F64, loc }, mode],
    type: F64,
    loc,
  };
}

// fs.openSync(path, flags[, mode]) with Node's string flags: the runtime
// selects the O_* bits from the flag text, and mode is the creation mode
// open(2) applies when the file is created. An omitted mode passes Node's
// 0o666 default, so every call reaches the runtime with three arguments.
export function lowerFsOpenCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (
    expr.arguments.nodes.length < 2 ||
    expr.arguments.nodes.length > 3 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  )
    lowerer.noLowering("openSync with this argument shape", expr);
  const mode = expr.arguments.nodes[2];
  const defaultMode = numLit(0o666, loc);
  return {
    kind: "libCall",
    fn: "fs.openSync",
    args: [
      lowerFsPath(lowerer, expr.arguments.nodes[0]!),
      lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, STRING),
      // Node treats an undefined creation mode as an omitted one.
      mode ? lowerBuiltinOptionalDefault(lowerer, mode, F64, defaultMode) : defaultMode,
    ],
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

/** fs.writeFileSync / fs.appendFileSync / fs.promises.writeFile /
 * fs.promises.appendFile. The data is a string, an ArrayBufferView's bytes,
 * or the string|Uint8Array union a shared helper's parameter carries. The optional
 * third argument is a bare encoding name or the options record; every value
 * in it is an ordinary expression, evaluated in the record's source order
 * before the write, and the runtime validates the encoding, the flag and the
 * mode in the order Node validates them. */
export function lowerFsWriteCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const promise = bi.module === "fs/promises";
  const family: WriteFamily = {
    promise,
    append: bi.member === "appendFile" || bi.member === "appendFileSync",
  };
  const operation = promise ? `fs.promises.${bi.member}` : bi.member;
  const nodes = expr.arguments.nodes;
  const supported = `write a string or ArrayBufferView with the options record { encoding?, mode?, flag?, flush? }: ${operation}(path, data, options)`;
  if (nodes.length < 2 || nodes.length > 3 || nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${operation} with ${nodes.length} arguments`, expr, supported);
  }
  const dataNode = nodes[1]!;
  const { dataKind, union, arms } = writeDataShape(lowerer, dataNode, operation);
  const resultType: IrType = promise ? { kind: "promise", inner: VOID } : VOID;
  // fs/promises writeFile/appendFile take a FileHandle where they take a path;
  // the callback forms do not. The handle's record behaves as it does for
  // FileHandle.writeFile, but the write itself is the descriptor write.
  const pathNode = nodes[0]!;
  if (promise && lowerer.mapTypeOf(lowerer.typeOf(pathNode))?.kind === "fileHandle") {
    if (union || dataKind === null) {
      lowerer.noLowering(
        `${operation} of a string|Uint8Array union to a FileHandle`,
        dataNode,
        "write a string or ArrayBufferView to a FileHandle",
      );
    }
    return lowerFileHandleWrite(
      lowerer,
      loc,
      () => lowerer.lowerExprExpecting(pathNode, FILEHANDLE_T),
      dataNode,
      dataKind!,
      nodes[2],
      operation,
      "path",
    );
  }
  const path = lowerFsPath(lowerer, nodes[0]!);
  if (nodes.length === 2) {
    if (union && arms) {
      return lowerStringOrBytesWrite(
        lowerer,
        loc,
        union,
        arms,
        family,
        null,
        path,
        lowerer.lowerExprExpecting(dataNode, union),
      );
    }
    const kind = dataKind!;
    return {
      kind: "libCall",
      fn: fsWriteLibFn(family, kind, false),
      args: [path, lowerWriteData(lowerer, dataNode, kind)],
      type: resultType,
      loc,
    };
  }
  // Stage the path, the data, and then the record's values in source order
  // before issuing the write: Node evaluates the call's arguments in that
  // order, and a value the checker cannot pin down must still be evaluated
  // exactly once, where the source put it.
  const stmts: IrStmt[] = [];
  const dataType: IrType = union ?? (dataKind === "bytes" ? BYTES_U8 : STRING);
  const pathLocal = lowerer.declareHiddenLocal("%writePath", STRING);
  stmts.push({ kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc });
  const dataLocal = lowerer.declareHiddenLocal("%writeData", dataType);
  stmts.push({
    kind: "varDecl",
    localId: dataLocal.id,
    init: union
      ? lowerer.lowerExprExpecting(dataNode, union)
      : lowerWriteData(lowerer, dataNode, dataKind === "bytes" ? "bytes" : "string"),
    loc,
  });
  const defaults: Record<WriteOptionSlot, IrExpr> = {
    encoding: { kind: "strLit", value: "utf8", type: STRING, loc },
    mode: { kind: "numLit", value: 0o666, type: F64, loc },
    flag: { kind: "strLit", value: family.append ? "a" : "w", type: STRING, loc },
    flush: boolLit(false, loc),
  };
  const slots: Partial<Record<WriteOptionSlot, IrExpr>> = {};
  const entries = lowerWriteOptions(lowerer, nodes[2]!, operation, supported, defaults);
  let encodingEntry: LoweredWriteOption | undefined;
  let stagedFast: IrExpr | null = null;
  for (const entry of entries) {
    if (entry.slot === null) {
      stmts.push({ kind: "exprStmt", expr: entry.expr, loc: entry.expr.loc });
      continue;
    }
    const staged = stageWriteOption(lowerer, entry, stmts, loc);
    slots[entry.slot] = staged.value;
    stagedFast = staged.fast ?? stagedFast;
    if (entry.slot === "encoding") encodingEntry = entry;
  }
  const encoding = slots.encoding ?? defaults.encoding;
  const options: WriteOptions = {
    encoding,
    fast: stagedFast ?? writeFastArg(lowerer, encodingEntry, nodes[2]!, encoding, loc),
    mode: slots.mode ?? defaults.mode,
    flag: slots.flag ?? defaults.flag,
    flush: slots.flush ?? defaults.flush,
  };
  const pathRef = varRef(pathLocal.id, pathLocal.type, loc);
  const dataRef = varRef(dataLocal.id, dataLocal.type, loc);
  const result: IrExpr =
    union && arms
      ? lowerStringOrBytesWrite(lowerer, loc, union, arms, family, options, pathRef, dataRef)
      : {
          kind: "libCall",
          fn: fsWriteLibFn(family, dataKind!, true),
          args:
            dataKind === "bytes" || promise
              ? [pathRef, dataRef, options.encoding, options.mode, options.flag, options.flush]
              : [
                  pathRef,
                  dataRef,
                  options.encoding,
                  options.fast,
                  options.mode,
                  options.flag,
                  options.flush,
                ],
          type: resultType,
          loc,
        };
  return { kind: "seqExpr", stmts, result, type: resultType, loc };
}

/** The data shapes the write families accept: a string, an ArrayBufferView's
 * bytes, or the string|Uint8Array union a shared helper's parameter carries. */
interface WriteDataShape {
  dataKind: "string" | "bytes" | null;
  union: Extract<IrType, { kind: "union" }> | null;
  arms: readonly IrType[] | null;
}

function writeDataShape(lowerer: Lowerer, node: ts.Expression, operation: string): WriteDataShape {
  const ir = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (ir?.kind === "string") return { dataKind: "string", union: null, arms: null };
  if (ir?.kind === "bytes") return { dataKind: "bytes", union: null, arms: null };
  if (ir?.kind === "union") {
    const arms = lowerer.unions.get(ir.unionId)?.arms;
    if (
      arms &&
      arms.every((arm) => arm.kind === "string" || (arm.kind === "bytes" && arm.elem === "u8"))
    ) {
      return { dataKind: null, union: ir, arms };
    }
  }
  lowerer.noLowering(
    `${operation} of '${ir ? lowerer.fmt(ir) : lowerer.checker.typeToString(lowerer.typeOf(node))}' data`,
    node,
    "write data is a string, a Buffer, Uint8Array, DataView or another typed array",
  );
}

/** A write's data as the Uint8Array the byte entries take. Node writes the
 * bytes of any ArrayBufferView, so a view of another element type is a u8
 * view over the same storage rather than a conversion. */
function writeDataBytes(lowerer: Lowerer, node: ts.Expression, value: IrExpr): IrExpr {
  if (value.type.kind !== "bytes" || value.type.elem === "u8") return value;
  return {
    kind: "libCall",
    fn: "bytes.bufferSource",
    args: [lowerer.coerceInto(node, value, DYN)],
    type: BYTES_U8,
    loc: locOf(node),
  };
}

/** The data argument of a write, lowered to the type its entry takes. */
function lowerWriteData(lowerer: Lowerer, node: ts.Expression, kind: "string" | "bytes"): IrExpr {
  if (kind === "string") return lowerer.lowerExprExpecting(node, STRING);
  return writeDataBytes(lowerer, node, lowerer.lowerExpr(node));
}

/** Node's string-utf8 arm: string data under an encoding that is exactly
 * "utf8" or "utf-8" skips the Buffer conversion and the fsync (and, over a
 * descriptor, the range check). No options argument, null and undefined
 * reach it through getOptions' defaults; a record without an encoding key
 * does not, because its encoding stays undefined. An encoding value whose
 * type also admits null or undefined is decided from the staged value
 * instead (stageWriteOption). */
function writeFastArg(
  lowerer: Lowerer,
  encoding: LoweredWriteOption | undefined,
  optsNode: ts.Expression,
  lowered: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (!encoding) {
    const flags = lowerer.typeOf(stripTypeCasts(optsNode)).flags;
    return boolLit(
      (flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0,
      loc,
    );
  }
  if (encoding.stringLiteral !== undefined)
    return boolLit(isUtf8Encoding(encoding.stringLiteral), loc);
  // An encoding name the checker cannot pin down is read from the staged
  // local here and passed to the write as the same local.
  const ref = (): IrExpr =>
    lowered.kind === "varRef" ? varRef(lowered.localId, lowered.type, loc) : lowered;
  const eq = (value: string): IrExpr => ({
    kind: "strEq",
    negated: false,
    left: ref(),
    right: { kind: "strLit", value, type: STRING, loc },
    type: BOOL,
    loc,
  });
  return { kind: "logical", op: "||", left: eq("utf8"), right: eq("utf-8"), type: BOOL, loc };
}

function isUtf8Encoding(name: string): boolean {
  return name === "utf8" || name === "utf-8";
}

/** Stage one evaluated option into a hidden local. A defaulted encoding
 * whose type also admits null or undefined stages the RAW value: Node reads
 * the record's encoding as written to pick its arm (an absent one is not
 * the "utf8" it falls back to), while the write takes the defaulted
 * spelling, so both come from the one evaluation. */
function stageWriteOption(
  lowerer: Lowerer,
  entry: LoweredWriteOption,
  stmts: IrStmt[],
  loc: SrcLoc,
): { value: IrExpr; fast: IrExpr | null } {
  const absent = entry.slot === "encoding" && entry.expr.kind === "nullish" ? entry.expr : null;
  const init = absent ? absent.left : entry.expr;
  const local = lowerer.declareHiddenLocal(`%write${entry.slot}`, init.type);
  stmts.push({ kind: "varDecl", localId: local.id, init, loc: init.loc });
  const ref = varRef(local.id, local.type, loc);
  if (!absent) return { value: ref, fast: null };
  return {
    value: { kind: "nullish", left: ref, right: absent.right, type: absent.type, loc },
    fast: writeFastOfValue(lowerer, ref, loc),
  };
}

/** `options.encoding === 'utf8' || options.encoding === 'utf-8'` over a
 * value that may be absent at run time: the arm "utf8" is the default, so
 * the comparison reads the string arm only once no absent tag matched. */
function writeFastOfValue(lowerer: Lowerer, raw: IrExpr, loc: SrcLoc): IrExpr {
  const type = raw.type;
  const arms = type.kind === "union" ? lowerer.unions.get(type.unionId)?.arms : undefined;
  const stringTag = arms?.findIndex((arm) => arm.kind === "string") ?? -1;
  const absentTags = arms?.flatMap((arm, tag) => (isUnitType(arm) ? [tag] : [])) ?? [];
  if (type.kind !== "union" || !arms || stringTag < 0 || absentTags.length === 0) {
    throw new InternalCompilerError("an encoding default without an absent arm");
  }
  const isTag = (tag: number): IrExpr => ({
    kind: "unionIsTag",
    unionId: type.unionId,
    tag,
    negated: false,
    value: raw,
    type: BOOL,
    loc,
  });
  let absent: IrExpr = isTag(absentTags[0]!);
  for (const tag of absentTags.slice(1)) {
    absent = { kind: "logical", op: "||", left: absent, right: isTag(tag), type: BOOL, loc };
  }
  const isUtf8 = (name: string): IrExpr => ({
    kind: "strEq",
    negated: false,
    left: {
      kind: "unionNarrow",
      unionId: type.unionId,
      tag: stringTag,
      value: raw,
      type: STRING,
      loc,
    },
    right: { kind: "strLit", value: name, type: STRING, loc },
    type: BOOL,
    loc,
  });
  return {
    kind: "ternary",
    cond: absent,
    then: boolLit(false, loc),
    else_: {
      kind: "logical",
      op: "||",
      left: isUtf8("utf8"),
      right: isUtf8("utf-8"),
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}

// writeFileSync(fd, data[, options]) and appendFileSync(fd, data[, options])
// — Node accepts a file descriptor where it accepts a path (write to a
// descriptor openSync returned, the descriptor staying open: closeSync owns
// its lifetime). Routed by the ARGUMENT's static type, like readFileSync(fd).
// The record means the same as on the path form except that the flag and the
// mode only survive on the string-utf8 arm, and appendFileSync forces its
// own flag whenever the value names a descriptor.
export function lowerFsWriteDescriptorCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  const family: WriteFdFamily = { append: bi.member === "appendFileSync" };
  const operation = `fs.${bi.member}`;
  const supported = `write a string or ArrayBufferView to a descriptor with the options record { encoding?, mode?, flag?, flush? }: ${operation}(fd, data, options)`;
  const nodes = expr.arguments.nodes;
  if (nodes.length < 2 || nodes.length > 3 || nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`${operation} with ${nodes.length} arguments`, expr, supported);
  }
  const dataNode = nodes[1]!;
  const { dataKind, union, arms } = writeDataShape(lowerer, dataNode, operation);
  const fd = lowerer.lowerExprExpecting(nodes[0]!, F64);
  const defaultFlag = family.append ? "a" : "w";
  if (nodes.length === 2) {
    if (union && arms) {
      return lowerStringOrBytesWriteFd(
        lowerer,
        loc,
        union,
        arms,
        family,
        null,
        fd,
        lowerer.lowerExprExpecting(dataNode, union),
      );
    }
    const data = lowerWriteData(lowerer, dataNode, dataKind === "bytes" ? "bytes" : "string");
    if (dataKind === "bytes") {
      return {
        kind: "libCall",
        fn: fsWriteFdLibFn(family, "bytes"),
        args: [fd, data, { kind: "strLit", value: "utf8", type: STRING, loc }, boolLit(false, loc)],
        type: VOID,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: fsWriteFdLibFn(family, "string"),
      args: [
        fd,
        data,
        { kind: "strLit", value: "utf8", type: STRING, loc },
        boolLit(true, loc),
        { kind: "numLit", value: 0o666, type: F64, loc },
        { kind: "strLit", value: defaultFlag, type: STRING, loc },
        boolLit(false, loc),
      ],
      type: VOID,
      loc,
    };
  }
  // Stage the descriptor, the data, and then the record's values in source
  // order: Node evaluates the call's arguments in that order, and a value
  // the checker cannot pin down must still be evaluated exactly once, where
  // the source put it.
  const stmts: IrStmt[] = [];
  const fdLocal = lowerer.declareHiddenLocal("%writeFd", F64);
  stmts.push({ kind: "varDecl", localId: fdLocal.id, init: fd, loc: fd.loc });
  const dataType: IrType = union ?? (dataKind === "bytes" ? BYTES_U8 : STRING);
  const dataLocal = lowerer.declareHiddenLocal("%writeData", dataType);
  stmts.push({
    kind: "varDecl",
    localId: dataLocal.id,
    init: union
      ? lowerer.lowerExprExpecting(dataNode, union)
      : lowerWriteData(lowerer, dataNode, dataKind === "bytes" ? "bytes" : "string"),
    loc,
  });
  const defaults: Record<WriteOptionSlot, IrExpr> = {
    encoding: { kind: "strLit", value: "utf8", type: STRING, loc },
    mode: { kind: "numLit", value: 0o666, type: F64, loc },
    flag: { kind: "strLit", value: defaultFlag, type: STRING, loc },
    flush: boolLit(false, loc),
  };
  const slots: Partial<Record<WriteOptionSlot, IrExpr>> = {};
  let encodingEntry: LoweredWriteOption | undefined;
  let stagedFast: IrExpr | null = null;
  for (const entry of lowerWriteOptions(lowerer, nodes[2]!, operation, supported, defaults)) {
    if (entry.slot === null) {
      stmts.push({ kind: "exprStmt", expr: entry.expr, loc: entry.expr.loc });
      continue;
    }
    const staged = stageWriteOption(lowerer, entry, stmts, loc);
    slots[entry.slot] = staged.value;
    stagedFast = staged.fast ?? stagedFast;
    if (entry.slot === "encoding") encodingEntry = entry;
  }
  const encoding = slots.encoding ?? defaults.encoding;
  const options: WriteOptions = {
    encoding,
    fast: stagedFast ?? writeFastArg(lowerer, encodingEntry, nodes[2]!, encoding, loc),
    mode: slots.mode ?? defaults.mode,
    // appendFileSync overwrites the flag for a descriptor, after evaluating
    // it: `{ flag: "zz" }` is still read, and never parsed.
    flag: family.append ? defaults.flag : (slots.flag ?? defaults.flag),
    flush: slots.flush ?? defaults.flush,
  };
  const fdRef = varRef(fdLocal.id, F64, loc);
  const dataRef = varRef(dataLocal.id, dataLocal.type, loc);
  const result: IrExpr =
    union && arms
      ? lowerStringOrBytesWriteFd(lowerer, loc, union, arms, family, options, fdRef, dataRef)
      : {
          kind: "libCall",
          fn: fsWriteFdLibFn(family, dataKind!),
          args:
            dataKind === "bytes"
              ? [fdRef, dataRef, options.encoding, options.flush]
              : [
                  fdRef,
                  dataRef,
                  options.encoding,
                  options.fast,
                  options.mode,
                  options.flag,
                  options.flush,
                ],
          type: VOID,
          loc,
        };
  return { kind: "seqExpr", stmts, result, type: VOID, loc };
}

/** FileHandle.writeFile/appendFile(data, options): Node reads the same write
 * record, but a handle opens nothing. The encoding is validated and applies
 * to string data exactly as Buffer.from does; the flag, mode and flush values
 * are evaluated in source order and unused, and no fsync runs. `handle` is a
 * thunk so the receiver binds before the data and the record, the call's own
 * argument order. The "path" form is fs/promises writeFile/appendFile with a
 * FileHandle as the path: Node converts the string and then writes it to the
 * descriptor, with no handle-open check in between. */
export function lowerFileHandleWrite(
  lowerer: Lowerer,
  loc: SrcLoc,
  handle: () => IrExpr,
  dataNode: ts.Expression,
  dataKind: "string" | "bytes",
  optsNode: ts.Expression | undefined,
  operation: string,
  form: "call" | "path" = "call",
): IrExpr {
  const dataType = dataKind === "bytes" ? BYTES_U8 : STRING;
  const fn =
    dataKind === "bytes"
      ? form === "path"
        ? "fileHandle.writeFilePathBytes"
        : "fileHandle.writeFileBytes"
      : form === "path"
        ? "fileHandle.writeFilePath"
        : "fileHandle.writeFile";
  const type: IrType = { kind: "promise", inner: VOID };
  const utf8: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
  const data = (): IrExpr => lowerWriteData(lowerer, dataNode, dataKind);
  if (!optsNode) {
    return { kind: "libCall", fn, args: [handle(), data(), utf8], type, loc };
  }
  // A bare encoding expression takes any string value, validated at run time
  // like the path forms'. Only a record goes through the option parser.
  const optsType = lowerer.mapTypeOf(lowerer.typeOf(optsNode));
  const encodingOnly =
    optsType?.kind === "string" ||
    (optsType?.kind === "union" &&
      (lowerer.unions
        .get(optsType.unionId)
        ?.arms.every((arm) => arm.kind === "string" || isUnitType(arm)) ??
        false));
  if (encodingOnly) {
    const encoding = lowerBuiltinOptionalDefault(
      lowerer,
      stripTypeCasts(optsNode),
      STRING,
      utf8,
      true,
    );
    return { kind: "libCall", fn, args: [handle(), data(), encoding], type, loc };
  }
  const supported = `write a string or ArrayBufferView with the options record { encoding?, mode?, flag?, flush? }: ${operation}(data, options)`;
  // Stage the receiver, the data, and then the record's values in source
  // order before issuing the write: Node evaluates the call's arguments in
  // that order, and a value the checker cannot pin down must still be
  // evaluated exactly once, where the source put it.
  const stmts: IrStmt[] = [];
  const handleValue = handle();
  const handleLocal = lowerer.declareHiddenLocal("%fhWriteHandle", handleValue.type);
  stmts.push({ kind: "varDecl", localId: handleLocal.id, init: handleValue, loc: handleValue.loc });
  const dataLocal = lowerer.declareHiddenLocal("%fhWriteData", dataType);
  stmts.push({ kind: "varDecl", localId: dataLocal.id, init: data(), loc });
  const defaults: Record<WriteOptionSlot, IrExpr> = {
    encoding: utf8,
    mode: { kind: "numLit", value: 0o666, type: F64, loc },
    flag: { kind: "strLit", value: "w", type: STRING, loc },
    flush: boolLit(false, loc),
  };
  let encoding: IrExpr = utf8;
  for (const entry of lowerWriteOptions(
    lowerer,
    optsNode,
    operation,
    supported,
    defaults,
    HANDLE_WRITE_OPTION_SLOTS,
  )) {
    if (entry.slot === "encoding") {
      encoding = stageWriteOption(lowerer, entry, stmts, loc).value;
    } else {
      stmts.push({ kind: "exprStmt", expr: entry.expr, loc: entry.expr.loc });
    }
  }
  const result: IrExpr = {
    kind: "libCall",
    fn,
    args: [
      varRef(handleLocal.id, handleLocal.type, loc),
      varRef(dataLocal.id, dataLocal.type, loc),
      encoding,
    ],
    type,
    loc,
  };
  return { kind: "seqExpr", stmts, result, type, loc };
}

type WriteOptionSlot = "encoding" | "mode" | "flag" | "flush";

const ALL_WRITE_OPTION_SLOTS: ReadonlySet<WriteOptionSlot> = new Set([
  "encoding",
  "mode",
  "flag",
  "flush",
]);

/** The slots a FileHandle write takes: a handle opens nothing, so only the
 * encoding reaches the runtime. The other record values are evaluated where
 * the source put them and then unused, exactly as Node reads them without a
 * syscall. */
const HANDLE_WRITE_OPTION_SLOTS: ReadonlySet<WriteOptionSlot> = new Set(["encoding"]);

/** One evaluated option: a lowered slot value, or the value of a key whose
 * value is evaluated and not used. `stringLiteral` is the encoding's literal
 * spelling, when the checker pins it down. */
type LoweredWriteOption = {
  slot: WriteOptionSlot | null;
  expr: IrExpr;
  stringLiteral?: string | undefined;
};

/** The third argument's values, in source order. A bare encoding name is the
 * record's encoding key alone; null and undefined take every default; the
 * record itself is an object literal or a readonly const binding of one.
 * `consumed` names the slots the call's runtime takes; a documented key
 * outside it is still evaluated, in record order, and dropped. */
function lowerWriteOptions(
  lowerer: Lowerer,
  optsNode: ts.Expression,
  operation: string,
  supported: string,
  defaults: Record<WriteOptionSlot, IrExpr>,
  consumed: ReadonlySet<WriteOptionSlot> = ALL_WRITE_OPTION_SLOTS,
): LoweredWriteOption[] {
  const entries: LoweredWriteOption[] = [];
  const t = lowerer.typeOf(optsNode);
  if ((t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
    return entries;
  }
  if (lowerer.mapTypeOf(t)?.kind === "string") {
    const unwrapped = stripTypeCasts(optsNode);
    const bare = lowerer.typeOf(unwrapped);
    entries.push({
      slot: "encoding",
      expr: lowerBuiltinOptionalDefault(lowerer, unwrapped, STRING, defaults.encoding, true),
      stringLiteral: bare.isStringLiteralType() ? bare.value : undefined,
    });
    return entries;
  }
  const literal = optionsLiteralOf(lowerer, optsNode);
  if (literal === null) {
    lowerer.noLowering(`${operation} with 3 arguments`, optsNode, supported);
  }
  for (const property of literal.properties.nodes) {
    const member = optionMember(property);
    if (!member) lowerer.noLowering(`${operation} options`, property, supported);
    const value = member.value;
    const slot = writeOptionSlotOf(member.name);
    if (slot !== null && !consumed.has(slot)) {
      entries.push({ slot: null, expr: lowerer.lowerExpr(value) });
      continue;
    }
    switch (member.name) {
      case "encoding": {
        // An encoding assertion (`maybe as BufferEncoding`) selects the
        // value as written: Node validates the value itself and never
        // converts it, so the assertion adds nothing at run time.
        const unwrapped = stripTypeCasts(value);
        const valueType = lowerer.typeOf(unwrapped);
        entries.push({
          slot: "encoding",
          expr: lowerBuiltinOptionalDefault(lowerer, unwrapped, STRING, defaults.encoding, true),
          stringLiteral: valueType.isStringLiteralType() ? valueType.value : undefined,
        });
        break;
      }
      case "mode": {
        // parseFileMode: a number, or an octal string parsed to its numeric
        // value. A literal octal string folds to the number the runtime
        // takes. An expression the checker types as one such string is not
        // the string itself: Node still runs it, so a side effect happens
        // and a throw stops the write, and its text parses the same way.
        // Any other string spelling would be a runtime error, so it is
        // refused with the reason instead of being dropped.
        const modeNode = stripTypeCasts(value);
        const modeType = lowerer.typeOf(modeNode);
        if (modeType.isStringLiteralType()) {
          if (!/^[0-7]+$/.test(modeType.value)) {
            lowerer.noLowering(
              `a '${modeType.value}' mode`,
              value,
              "write mode takes a number or an octal digit string",
            );
          }
          const modeLoc = locOf(value);
          entries.push({
            slot: "mode",
            expr: ts.isStringLiteral(modeNode)
              ? { kind: "numLit", value: parseInt(modeType.value, 8), type: F64, loc: modeLoc }
              : {
                  kind: "libCall",
                  fn: "num.parseInt",
                  args: [
                    lowerer.lowerExprExpecting(modeNode, STRING),
                    { kind: "numLit", value: 8, type: F64, loc: modeLoc },
                  ],
                  type: F64,
                  loc: modeLoc,
                },
          });
        } else {
          entries.push({
            slot: "mode",
            expr: lowerBuiltinOptionalDefault(lowerer, value, F64, defaults.mode, true),
          });
        }
        break;
      }
      case "flag":
        entries.push({
          slot: "flag",
          expr: lowerBuiltinOptionalDefault(lowerer, value, STRING, defaults.flag, true),
        });
        break;
      case "flush":
        entries.push({
          slot: "flush",
          expr: lowerBuiltinOptionalDefault(lowerer, value, BOOL, defaults.flush, true),
        });
        break;
      default:
        // The options-record stance: documented keys with no lowering fence
        // by name; undocumented keys drop like Node.
        fenceOrDropOptionKey(
          lowerer,
          property,
          member.name,
          operation,
          FS_WRITE_FILE_DOCUMENTED_OPTIONS,
          supported,
          {
            signal:
              "cancelling a write through options.signal has no native lowering; drop the entry to write without cancellation",
          },
        );
    }
  }
  return entries;
}

/** The record slot a documented key fills. */
function writeOptionSlotOf(name: string): WriteOptionSlot | null {
  return name === "encoding" || name === "mode" || name === "flag" || name === "flush"
    ? name
    : null;
}

/** ts.CheckFlags.Readonly — the property symbol's readonly bit, the same
 * test decl-projection.ts makes for a projected declaration. */
const READONLY_CHECK_FLAG = 8;

/** The object literal behind a write options argument: the literal
 * itself, or the initializer of the const binding that holds it (through
 * type casts and parentheses). A const's values must all be literals —
 * inlining anything else would re-evaluate it at the write site — and the
 * binding's record must be readonly, so the inlined values are also what
 * a later read of the record would answer. */
function optionsLiteralOf(
  lowerer: Lowerer,
  node: ts.Expression,
): ts.ObjectLiteralExpression | null {
  // stripTypeCasts also strips parentheses: `({...} as const)` is the literal.
  const unwrap = (expr: ts.Expression): ts.Expression => stripTypeCasts(expr);
  const bare = unwrap(node);
  if (ts.isObjectLiteralExpression(bare)) return bare;
  if (!ts.isIdentifier(bare)) return null;
  const init = constInitializerOf(lowerer, bare);
  if (init === null) return null;
  const value = unwrap(init);
  if (!ts.isObjectLiteralExpression(value)) return null;
  // The literal values are inlined at the WRITE SITE. That is the same
  // evaluation Node performs — it reads the options record when the call
  // runs — only while the record cannot change after its initializer: a
  // mutable one (`const OPTS: { mode: number } = { mode: 0o600 }`) would
  // let `OPTS.mode = 0o644` reach Node's write and not this one. Only a
  // readonly record (`as const`, `Readonly<...>`) admits the inline; the
  // rest keep the SC2020 fence.
  const props = lowerer.checker.getPropertiesOfType(lowerer.typeOf(bare));
  if (props.length === 0 || !props.every((p) => (p.checkFlags & READONLY_CHECK_FLAG) !== 0))
    return null;
  const literalValue = (expr: ts.Expression): boolean => {
    const v = unwrap(expr);
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return true;
    if (ts.isNumericLiteral(v)) return true;
    return (
      ts.isPrefixUnaryExpression(v) &&
      (v.operator === ts.SyntaxKind.MinusToken || v.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(v.operand)
    );
  };
  for (const p of value.properties.nodes) {
    const m = optionMember(p);
    if (!m || !literalValue(m.value)) return null;
  }
  return value;
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
