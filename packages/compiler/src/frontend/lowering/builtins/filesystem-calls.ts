import { dynUndefinedExpr, boolLit, numLit, strLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { type Lowerer } from "../lowerer.js";
import { jsFsPathValue, lowerFsPath } from "./fs-paths.js";
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
  type IrLibFn,
  type IrStmt,
  type IrType,
  NULL_T,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  funcOf,
  typeEquals,
} from "../../../ir/ir.js";
import { lowerBuiltinOptionalDefault, optionMember, literalBoolOptions } from "./arguments.js";
import { defaultAfterUndefined } from "../optional-arguments.js";
import { constInitializerOf } from "../lower-exprs.js";
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
  // fs.realpath.native is Node's same realpath binding under a second name;
  // the runtime dispatcher folds the two spellings into one op.
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
  const nodes = expr.arguments.nodes;
  if (nodes.length < required || nodes.length > required + 1 || nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with this argument shape`, expr);
  // The descriptor, the vector and the position the typed ABI pins down; a
  // JavaScript call with any of them left untyped runs Node's ladder (the
  // buffers argument's ArrayBufferView[] check, the empty-vector early
  // return, the position rule, then the descriptor) over the values.
  const buffersTyped = (() => {
    if (!vector) return true;
    const type = lowerer.mapTypeOf(lowerer.typeOf(nodes[1]!));
    return type?.kind === "array" && type.elem.kind === "bytes" && type.elem.elem === "u8";
  })();
  const positionKind = fsArgKind(lowerer, nodes[required]);
  const typed =
    fsArgKind(lowerer, nodes[0]) === "number" &&
    buffersTyped &&
    (positionKind === "number" || positionKind === "absent");
  if (!typed && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    const dynArgs: IrExpr[] = [lowerer.lowerExprExpecting(nodes[0]!, DYN)];
    if (nodes[1]) dynArgs.push(lowerer.lowerExprExpecting(nodes[1], DYN));
    else dynArgs.push(dynUndefinedExpr(loc));
    if (vector) {
      const position = nodes[2];
      dynArgs.push(position ? lowerer.lowerExprExpecting(position, DYN) : dynUndefinedExpr(loc));
    }
    return {
      kind: "libCall",
      fn: vector
        ? bi.member === "readvSync"
          ? "fs.readvSyncDyn"
          : "fs.writevSyncDyn"
        : "fs.ftruncateSyncDyn",
      args: dynArgs,
      type: vector ? F64 : VOID,
      loc,
    };
  }
  const args = [lowerer.lowerExprExpecting(nodes[0]!, F64)];
  if (vector) args.push(lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, arrayOf(BYTES_U8)));
  const optional = expr.arguments.nodes[required];
  args.push(
    optional
      ? lowerBuiltinOptionalDefault(lowerer, optional, F64, numLit(vector ? -1 : 0, loc), vector)
      : numLit(vector ? -1 : 0, loc),
  );
  return { kind: "libCall", fn: fn.fn, args, type: vector ? F64 : VOID, loc };
}

/** The statically visible kind of an optional fs argument: `absent` for the
 * call's omitted argument and the spellings Node's `??=` treats as one
 * (`undefined`, `null`), `number`/`string`/`boolean` when the checker narrows
 * the value to that scalar, and `dyn` for everything only the runtime sees
 * (`any`, unions, restored narrowings). Each kind selects the entry point
 * whose argument types match, so a typed call keeps its fast path and a value
 * that needs Node's ladder runs it at run time. */
function fsArgKind(lowerer: Lowerer, node: ts.Expression | null | undefined): FsArgKind {
  if (!node) return "absent";
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (mapped === null) return "dyn";
  switch (mapped.kind) {
    case "f64":
      return "number";
    case "string":
      return "string";
    case "bool":
      return "boolean";
    case "undefinedT":
    case "nullT":
    case "void":
      return "absent";
    default:
      return "dyn";
  }
}

type FsArgKind = "absent" | "number" | "string" | "boolean" | "dyn";

/** Whether the expression's static type can carry `null`. Node's option
 * reads compare a member with undefined alone, so a null-typed member is
 * present and its own validation reports it at run time. */
function canBeNull(lowerer: Lowerer, node: ts.Expression): boolean {
  return (lowerer.typeOf(node).flags & ts.TypeFlags.Null) !== 0;
}

/** The value Node's `value ??= def` answers: the argument's own effects, then
 * the default. Used where the argument's static type is one Node treats as
 * absent (`mkdirSync(p, true)` and `mkdirSync(p, null)` both mean the
 * defaults). */
function defaultAfter(lowerer: Lowerer, node: ts.Expression, dflt: IrExpr): IrExpr {
  return defaultAfterUndefined(lowerer.lowerExpr(node), dflt);
}

/** Numeric open flags written as an inline bitwise OR of fs.constants.O_*
 * members, as the compiler's platform-independent mask. The O_* values differ
 * between Darwin and Linux, so an inline expression keeps emitting the mask
 * the target runtime maps to its own constants. Null for any other numeric
 * expression, whose value is already the target's own bits. */
function inlineFlagsMask(lowerer: Lowerer, input: ts.Expression): number | null {
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
  const flagsOf = (expr: ts.Expression): number | null => {
    let node = expr;
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
  return flagsOf(input);
}

// fs.openSync(path, flags[, mode]) with Node's flag and mode grammar:
// stringToFlags reads a string flag name, a number as raw open(2) bits, and
// an omitted/`null`/`undefined` flags as "r"; parseFileMode reads the
// creation mode as a number or an octal string and passes 0o666 for an absent
// one. The path validates first, then the flags, then the mode.
export function lowerFsOpenSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (args.length < 1 || args.length > 3 || args.some(ts.isSpreadElement))
    lowerer.noLowering("openSync with this argument shape", expr);
  const path = lowerFsPath(lowerer, args[0]!);
  const flagsKind = fsArgKind(lowerer, args[1]);
  const modeKind = fsArgKind(lowerer, args[2]);
  const call = (fn: IrLibFn, fnArgs: IrExpr[]): IrExpr => ({
    kind: "libCall",
    fn,
    args: fnArgs,
    type: F64,
    loc,
  });
  // parseFileMode's default: an absent creation mode is Node's 0o666.
  const defaultMode = numLit(0o666, loc);
  const numericMode = (): IrExpr =>
    args[2] ? lowerBuiltinOptionalDefault(lowerer, args[2], F64, defaultMode, true) : defaultMode;
  const dynMode = (): IrExpr =>
    args[2] ? lowerer.lowerExprExpecting(args[2], DYN) : dynUndefinedExpr(loc);

  if (flagsKind !== "number") {
    if (flagsKind === "dyn" || flagsKind === "boolean") {
      // stringToFlags' arm is the runtime's to pick: a number is raw bits, a
      // string is the flag grammar, and anything else throws its TypeError.
      const flags = lowerer.lowerExprExpecting(args[1]!, DYN);
      return call("fs.openDynSync", [path, flags, dynMode()]);
    }
    // "r" for an omitted, `null` or `undefined` flags value.
    const defaultFlags = strLit("r", loc);
    const flags = args[1]
      ? lowerBuiltinOptionalDefault(lowerer, args[1], STRING, defaultFlags, true)
      : defaultFlags;
    if (modeKind === "string") {
      return call("fs.openStrModeSync", [
        path,
        flags,
        lowerer.lowerExprExpecting(args[2]!, STRING),
      ]);
    }
    if (modeKind === "absent" || modeKind === "number")
      return call("fs.openSync", [path, flags, numericMode()]);
    return call("fs.openModeDynSync", [path, flags, dynMode()]);
  }
  const mask = inlineFlagsMask(lowerer, args[1]!);
  if (mask !== null) {
    if (modeKind === "string") {
      return call("fs.openNumericStrSync", [
        path,
        { kind: "numLit", value: mask, type: F64, loc },
        lowerer.lowerExprExpecting(args[2]!, STRING),
      ]);
    }
    if (modeKind !== "absent" && modeKind !== "number") {
      return call("fs.openNumericDynSync", [
        path,
        { kind: "numLit", value: mask, type: F64, loc },
        dynMode(),
      ]);
    }
    return call("fs.openNumericSync", [
      path,
      { kind: "numLit", value: mask, type: F64, loc },
      numericMode(),
    ]);
  }
  const flags = lowerer.lowerExprExpecting(args[1]!, F64);
  if (modeKind === "string") {
    return call("fs.openNativeStrSync", [
      path,
      flags,
      lowerer.lowerExprExpecting(args[2]!, STRING),
    ]);
  }
  if (modeKind === "absent" || modeKind === "number")
    return call("fs.openNativeSync", [path, flags, numericMode()]);
  return call("fs.openNativeDynSync", [path, flags, dynMode()]);
}

// chmodSync(path, mode) and fchmodSync(fd, mode): parseFileMode reads the
// mode as a number or an octal string (an absent mode throws Node's
// ERR_INVALID_ARG_TYPE for `undefined`), and fchmodSync validates the mode
// before the descriptor. A statically numeric mode keeps the typed entry
// point — the runtime validates it there — so this answers null for the
// generic lowering, and the other kinds take the string and value forms.
export function lowerFsModeSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: "chmodSync" | "fchmodSync",
  loc: SrcLoc,
): IrExpr | null {
  const args = expr.arguments.nodes;
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement)) return null;
  const kind = fsArgKind(lowerer, args[1]);
  if (member === "fchmodSync" && fsArgKind(lowerer, args[0]) !== "number") {
    // The descriptor is only known at run time: parseFileMode reads the mode
    // first, then getValidatedFd checks the fd, both over the values.
    return {
      kind: "libCall",
      fn: "fs.fchmodSyncDyn",
      args: [
        lowerer.lowerExprExpecting(args[0]!, DYN),
        args[1] ? lowerer.lowerExprExpecting(args[1], DYN) : dynUndefinedExpr(loc),
      ],
      type: VOID,
      loc,
    };
  }
  if (kind === "number") return null;
  // The target the member names: the path for chmodSync, the descriptor for
  // fchmodSync — a number where the typed entry point takes one, a
  // dynamic value where Node's ladder reads it.
  const target = (type: IrType): IrExpr =>
    member === "chmodSync"
      ? lowerFsPath(lowerer, args[0]!)
      : lowerer.lowerExprExpecting(args[0]!, type);
  if (kind === "string") {
    return {
      kind: "libCall",
      fn: member === "chmodSync" ? "fs.chmodSyncStr" : "fs.fchmodSyncStr",
      args: [target(F64), lowerer.lowerExprExpecting(args[1]!, STRING)],
      type: VOID,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: member === "chmodSync" ? "fs.chmodSyncDyn" : "fs.fchmodSyncDyn",
    args: [target(DYN), args[1] ? lowerer.lowerExprExpecting(args[1], DYN) : dynUndefinedExpr(loc)],
    type: VOID,
    loc,
  };
}

// closeSync(fd), fsyncSync(fd), fdatasyncSync(fd) and fchownSync(fd, uid,
// gid): the descriptor primitives whose arguments are values Node passes to
// getValidatedFd (and, for fchown, validateInteger for the owner ids first).
// A call whose values the compiler pinned to numbers keeps the typed entry
// points — the runtime validates them there — so this answers null for the
// generic lowering and emits the run-time ladder for every other kind, where
// Node's typeof check reports the value it received instead of a coercion.
export function lowerFsDescriptorSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: "closeSync" | "fsyncSync" | "fdatasyncSync" | "fchownSync",
  loc: SrcLoc,
): IrExpr | null {
  const args = expr.arguments.nodes;
  const arity = member === "fchownSync" ? 3 : 1;
  if (args.length > arity || args.some(ts.isSpreadElement)) return null;
  if (args.every((arg) => fsArgKind(lowerer, arg) === "number")) return null;
  const fn: IrLibFn =
    member === "closeSync"
      ? "fs.closeSyncDyn"
      : member === "fsyncSync"
        ? "fs.fsyncSyncDyn"
        : member === "fdatasyncSync"
          ? "fs.fdatasyncSyncDyn"
          : "fs.fchownSyncDyn";
  const dynArgs: IrExpr[] = [];
  for (let index = 0; index < arity; index += 1) {
    const arg = args[index];
    dynArgs.push(arg ? lowerer.lowerExprExpecting(arg, DYN) : dynUndefinedExpr(loc));
  }
  return { kind: "libCall", fn, args: dynArgs, type: VOID, loc };
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

/** Whether an fs fd/offset/length-style argument's static type is the typed
 * form's number. An omitted argument is the form's default, and `nullable`
 * admits a literal null where the lowering completes it to the runtime's -1
 * current-offset sentinel. */
function fsNumberArg(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  nullable: boolean,
): boolean {
  if (node === undefined) return true;
  let value: ts.Expression = node;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  if (nullable && value.kind === ts.SyntaxKind.NullKeyword) return true;
  return lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "f64";
}

/** The typed readSync forms: readSync(fd, buffer), readSync(fd, buffer,
 * literalOptions), and readSync(fd, buffer, offset, length[, position]) over
 * a Uint8Array/Buffer descriptor. Anything else a JavaScript source writes
 * takes Node's run-time ladder. */
function readSyncTypedForm(lowerer: Lowerer, expr: ts.CallExpression): boolean {
  const nodes = expr.arguments.nodes;
  if (!fsNumberArg(lowerer, nodes[0], false)) return false;
  const bufferType = lowerer.mapTypeOf(lowerer.typeOf(nodes[1]!));
  if (bufferType?.kind !== "bytes" || bufferType.elem !== "u8") return false;
  if (nodes.length === 2) return true;
  if (nodes.length === 3) {
    let value: ts.Expression = nodes[2]!;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    return ts.isObjectLiteralExpression(value) || value.kind === ts.SyntaxKind.NullKeyword;
  }
  return (
    fsNumberArg(lowerer, nodes[2], false) &&
    fsNumberArg(lowerer, nodes[3], false) &&
    fsNumberArg(lowerer, nodes[4], true)
  );
}

/** The typed writeSync forms: the Uint8Array/Buffer window (with an omitted
 * or literal-null offset/length/position, a literal options object, or a
 * numeric offset with a numeric length and position) and the utf8 string
 * form. Anything else a JavaScript source writes takes Node's run-time
 * ladder, which also reads the options object and supports every encoding. */
function writeSyncTypedForm(lowerer: Lowerer, expr: ts.CallExpression): boolean {
  const nodes = expr.arguments.nodes;
  if (nodes.length < 2 || nodes.length > 5) return false;
  if (!fsNumberArg(lowerer, nodes[0], false)) return false;
  const dataType = lowerer.mapTypeOf(lowerer.typeOf(nodes[1]!));
  if (dataType?.kind === "bytes") {
    if (dataType.elem !== "u8") return false;
    if (nodes.length === 2) return true;
    if (nodes.length === 3) {
      let value: ts.Expression = nodes[2]!;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      return (
        ts.isObjectLiteralExpression(value) ||
        value.kind === ts.SyntaxKind.NullKeyword ||
        lowerer.mapTypeOf(lowerer.typeOf(nodes[2]!))?.kind === "f64"
      );
    }
    return (
      fsNumberArg(lowerer, nodes[2], false) &&
      fsNumberArg(lowerer, nodes[3], false) &&
      fsNumberArg(lowerer, nodes[4], true)
    );
  }
  if (dataType?.kind === "string") {
    if (nodes.length > 4 || !fsNumberArg(lowerer, nodes[2], true)) return false;
    const encoding = nodes[3];
    if (encoding === undefined) return true;
    const encodingType = lowerer.typeOf(encoding);
    return (
      encodingType.isStringLiteralType() &&
      (encodingType.value === "utf8" || encodingType.value === "utf-8")
    );
  }
  return false;
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
  // JavaScript arguments outside the typed signature (an untyped fd or
  // buffer, a bigint or untyped position, an options value only the runtime
  // sees) take Node's argument checks at run time, then the same read. The
  // call's own argument count decides Node's options form, so it crosses as
  // a number.
  if (isJsSourceFile(ts.getSourceFileOfNode(expr)) && !readSyncTypedForm(lowerer, expr)) {
    const nodes = expr.arguments.nodes;
    const args = [0, 1, 2, 3, 4].map((i): IrExpr => {
      const node = nodes[i];
      return node === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(node, DYN);
    });
    args.push(numLit(nodes.length, loc));
    return { kind: "libCall", fn: "fs.readSyncArgs", args, type: F64, loc };
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
  // A JavaScript call whose argument kinds the typed forms below do not pin
  // down runs Node's own ladder over the values: the view form's options
  // object and validateOffsetLengthWrite, or the string form's
  // validateEncoding and encoding.
  if (
    expr.arguments.nodes.length <= 5 &&
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    !writeSyncTypedForm(lowerer, expr)
  ) {
    const nodes = expr.arguments.nodes;
    const args = [0, 1, 2, 3, 4].map((i): IrExpr => {
      const node = nodes[i];
      return node === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(node, DYN);
    });
    return { kind: "libCall", fn: "fs.writeSyncArgs", args, type: F64, loc };
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

/** The `{ encoding, flag }` options record of readFileSync: the runtime runs
 * Node's whole options ladder (getOptions' encoding and signal checks,
 * stringToFlags, open(2) with 0o666) over the record, so the flag may be a
 * name, open(2) bits or a value the call site did not pin down. The answer's
 * arm is the call site's type: a string, a Buffer, or the unchecked value. */
function lowerFsReadOptionsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  options: ts.Expression,
  source: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const lowered = lowerer.lowerExpr(options);
  const value = lowered.type.kind === "dyn" ? lowered : lowerer.coerceInto(options, lowered, DYN);
  const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  const fn: IrLibFn =
    result?.kind === "string"
      ? "fs.readFileSyncStrOpts"
      : result?.kind === "bytes"
        ? "fs.readFileSyncBytesOpts"
        : "fs.readFileSyncDyn";
  return {
    kind: "libCall",
    fn,
    args: [source, value],
    type: result?.kind === "string" ? STRING : result?.kind === "bytes" ? BYTES_U8 : DYN,
    loc,
  };
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
  const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  // The unchecked read: Node's whole options ladder (getOptions' encoding and
  // signal checks, stringToFlags, open(2) with 0o666) runs over the value at
  // run time. Every option shape the call site did not pin down takes it —
  // an untyped helper's parameter, a union, a record with keys beyond
  // encoding/flag, or a value getOptions rejects.
  const dynamicRead = (): IrExpr => ({
    kind: "libCall",
    fn: "fs.readFileSyncDyn",
    args: [
      lowerFsPath(lowerer, expr.arguments.nodes[0]!),
      lowerer.lowerExprExpecting(options, DYN),
    ],
    type: DYN,
    loc,
  });
  const fields =
    optionsType?.kind === "record" ? lowerer.shapes.get(optionsType.shapeId)?.fields : undefined;
  const simpleRecord =
    fields !== undefined &&
    fields.length > 0 &&
    fields.every((entry) => entry.name === "encoding" || entry.name === "flag");
  const encodingField = simpleRecord
    ? fields.find((entry) => entry.name === "encoding")
    : undefined;
  const flagRead = simpleRecord && fields.some((entry) => entry.name === "flag");
  // The fd form never opens a path: Node ignores a record's flag, and only
  // the encoding-only reads below have a descriptor lowering.
  if (descriptor) {
    if (optionsType?.kind !== "string" && !(simpleRecord && encodingField?.type.kind === "string"))
      return null;
  } else if (optionsType?.kind === "string") {
    // A bare encoding is a string read unless the call site's answer is not
    // statically a string: an empty encoding is Node's Buffer answer, and an
    // unpinned answer may be an encoding only the runtime ladder can judge
    // ('buffer' passes assertEncoding and then fails in the decode).
    const literal = lowerer.typeOf(options);
    const empty = literal.isStringLiteralType() && literal.value === "";
    if (empty || result?.kind !== "string") return dynamicRead();
  } else if (simpleRecord) {
    // The path forms take the whole record — the flag included — to the
    // runtime; any encoding value that is not statically a string can select
    // the Buffer answer, so those go with it.
    if (flagRead || encodingField?.type.kind !== "string")
      return lowerFsReadOptionsCall(
        lowerer,
        expr,
        options,
        lowerFsPath(lowerer, expr.arguments.nodes[0]!),
        loc,
      );
    if (encodingIsEmptyLiteral(lowerer, options) || result?.kind !== "string") return dynamicRead();
  } else {
    return dynamicRead();
  }
  const sourceType = descriptor ? F64 : STRING;
  const source = descriptor
    ? lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, sourceType)
    : lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  // Past the branches above the options are a bare encoding or the simple
  // record whose encoding key selects this read.
  const optionsRecord = optionsType?.kind === "record" ? optionsType : undefined;
  const encoding: IrExpr =
    optionsType?.kind === "string"
      ? lowerer.lowerExprExpecting(options, STRING)
      : {
          kind: "recordGet",
          obj: encodingOptions(lowerer, options, optionsRecord!),
          shapeId: optionsRecord!.shapeId,
          field: "encoding",
          type: STRING,
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

/** Whether an options object literal spells an empty encoding, Node's
 * Buffer answer: a fresh read before the decode would answer bytes. */
function encodingIsEmptyLiteral(lowerer: Lowerer, options: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(options)) return false;
  for (const prop of options.properties.nodes) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
    if (prop.name.text !== "encoding") continue;
    const type = lowerer.typeOf(prop.initializer);
    return type.isStringLiteralType() && type.value === "";
  }
  return false;
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

/** mkdirSync's answer: Node's `string | undefined` (the first directory the
 * recursive walk created) where the call keeps it, and void where the
 * statement discards it — the shape the statement form has always emitted. */
function mkdirResultType(lowerer: Lowerer, expr: ts.CallExpression): IrType {
  const parent = expr.parent;
  if (parent !== undefined && ts.isExpressionStatement(parent)) return VOID;
  // A call whose declared type is void (mkdirSync's single-directory forms)
  // keeps the statement shape; one the checker types `string | undefined`
  // keeps the walk's answer, narrowed to the checked union when the type
  // world spells it another way (`string` alone, an `any`).
  const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (mapped === null) return lowerer.withUndefinedArm(STRING);
  if (mapped.kind === "void" || mapped.kind === "undefinedT") return VOID;
  return mapped.kind === "union" ? mapped : lowerer.withUndefinedArm(STRING);
}

// mkdirSync(p, options) with Node's option ladder: a number or a string is
// the mode itself, an absent/`null`/`undefined`/boolean options value means
// the 0o777 default, and an options object reads `recursive` (validated as a
// boolean) and then `mode` (parseFileMode under the name "options.mode").
// The runtime runs the same ladder for an options value only it can see. The
// recursive walk answers the first directory it created; the statement forms
// keep their void entry points, which release it.
export function lowerFsMkdirSyncCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  if (args.length < 1 || args.length > 2 || args.some(ts.isSpreadElement))
    lowerer.noLowering(`mkdirSync with ${args.length} arguments`, expr);
  const path = lowerFsPath(lowerer, args[0]!);
  const type = mkdirResultType(lowerer, expr);
  const optsNode = args[1];
  const kind = fsArgKind(lowerer, optsNode);
  const keepsValue = type.kind !== "void";
  if (kind === "number")
    return {
      kind: "libCall",
      fn: keepsValue ? "fs.mkdirModeValueSync" : "fs.mkdirModeSync",
      args: [path, lowerer.lowerExprExpecting(optsNode!, F64)],
      type,
      loc,
    };
  if (kind === "string")
    return {
      kind: "libCall",
      fn: keepsValue ? "fs.mkdirModeStrValueSync" : "fs.mkdirModeStrSync",
      args: [path, lowerer.lowerExprExpecting(optsNode!, STRING)],
      type,
      loc,
    };
  if (kind === "absent") {
    // A top-level mode is never recursive: the answer is undefined and the
    // statement form drops it, the value form narrows Node's union to it.
    const mode = optsNode
      ? defaultAfter(lowerer, optsNode, numLit(0o777, loc))
      : numLit(0o777, loc);
    return {
      kind: "libCall",
      fn: keepsValue ? "fs.mkdirModeValueSync" : optsNode ? "fs.mkdirModeSync" : "fs.mkdirSync",
      args: optsNode || keepsValue ? [path, mode] : [path],
      type,
      loc,
    };
  }
  const options = kind === "boolean" ? null : parseMkdirOptions(optsNode!);
  if (options) {
    const recursiveKind = fsArgKind(lowerer, options.recursive);
    const modeKind = fsArgKind(lowerer, options.mode);
    // The typed forms model Node's boolean `recursive` and its number or
    // octal-string `mode`. Any other typed arm — a null member (Node reads
    // a member by comparing it with undefined, so null is present and its
    // own validation reports it) or a boolean mode or a numeric recursive —
    // runs the runtime ladder, which throws Node's error instead of folding
    // the value away.
    const typedMode =
      options.mode === null ||
      modeKind === "number" ||
      modeKind === "string" ||
      (modeKind === "absent" && !canBeNull(lowerer, options.mode));
    const typedRecursive =
      options.recursive === null ||
      isBooleanLiteral(options.recursive) ||
      recursiveKind === "boolean" ||
      (recursiveKind === "absent" && !canBeNull(lowerer, options.recursive));
    if (typedRecursive && typedMode) {
      const recursiveNode = options.recursive;
      const recursive: IrExpr =
        recursiveNode === null
          ? boolLit(false, loc)
          : isTrueLiteral(recursiveNode)
            ? boolLit(true, loc)
            : isFalseLiteral(recursiveNode)
              ? boolLit(false, loc)
              : recursiveKind === "boolean"
                ? lowerer.lowerExprExpecting(recursiveNode, BOOL)
                : defaultAfter(lowerer, recursiveNode, boolLit(false, loc));
      const modeNode = options.mode;
      const mode: IrExpr =
        modeNode === null
          ? numLit(0o777, loc)
          : modeKind === "string"
            ? lowerer.lowerExprExpecting(modeNode, STRING)
            : modeKind === "number"
              ? lowerer.lowerExprExpecting(modeNode, F64)
              : defaultAfter(lowerer, modeNode, numLit(0o777, loc));
      const fn: IrLibFn =
        modeKind === "string"
          ? type.kind === "void"
            ? "fs.mkdirObjStrVoidSync"
            : "fs.mkdirObjStrSync"
          : type.kind === "void"
            ? "fs.mkdirObjVoidSync"
            : "fs.mkdirObjSync";
      return { kind: "libCall", fn, args: [path, mode, recursive], type, loc };
    }
  }
  // An options value whose arms only the runtime sees, or whose typed arms
  // are ones Node's ladder reports rather than folds: the runtime runs that
  // ladder over the whole object.
  const lowered = lowerer.lowerExpr(optsNode!);
  const value = lowered.type.kind === "dyn" ? lowered : lowerer.coerceInto(optsNode!, lowered, DYN);
  return {
    kind: "libCall",
    fn: type.kind === "void" ? "fs.mkdirDynVoidSync" : "fs.mkdirDynSync",
    args: [path, value],
    type,
    loc,
  };
}

function isBooleanLiteral(node: ts.Expression): boolean {
  const kind = withoutParenthesesTypeWrappers(node).kind;
  return kind === ts.SyntaxKind.TrueKeyword || kind === ts.SyntaxKind.FalseKeyword;
}

function isTrueLiteral(node: ts.Expression): boolean {
  return withoutParenthesesTypeWrappers(node).kind === ts.SyntaxKind.TrueKeyword;
}

function isFalseLiteral(node: ts.Expression): boolean {
  return withoutParenthesesTypeWrappers(node).kind === ts.SyntaxKind.FalseKeyword;
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
  if (!options || (options.recursive && !isBooleanLiteral(options.recursive))) {
    lowerer.noLowering(
      "fs.promises.mkdir with an options argument beyond { recursive: <boolean literal>, mode }",
      optsNode,
      "the recursive flag must be a boolean literal and mode a number; other options have no lowering",
    );
  }
  const recursive = options.recursive ? isTrueLiteral(options.recursive) : false;
  const modeNode = options.mode;
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

/** The two-argument write forms — fs.writeFileSync/appendFileSync and
 * fs/promises writeFile/appendFile — routed by the DATA argument's static
 * type. String data keeps the table's string entry (answers null); a u8
 * view takes the byte entry; a synchronous `string | u8 view` payload
 * dispatches on its tag. Everything else — a typed array of another
 * element, the ArrayBufferView alias, a checked-dynamic value, a promise
 * form's union — takes the checked-data entry, whose runtime validates the
 * argument the way Node does and then writes a string as text and a view as
 * the bytes it covers. */
export function lowerFsWriteBytesCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  const append = bi.member === "appendFileSync" || bi.member === "appendFile";
  const promise = bi.module === "fs/promises";
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!));
  // The synchronous `string | Uint8Array` payload dispatches on its tag
  // through the keyed void helper. The promise forms take the checked-data
  // unit for the same payload: their write answers a promise, which the
  // dispatch hands back from the runtime rather than from a void helper.
  if (!promise && dataIr?.kind === "union") {
    const arms = lowerer.unions.get(dataIr.unionId)?.arms;
    if (
      arms &&
      arms.every((arm) => arm.kind === "string" || (arm.kind === "bytes" && arm.elem === "u8"))
    ) {
      return lowerStringOrBytesWrite(lowerer, expr, dataIr, arms, append);
    }
  }
  if (dataIr?.kind === "string") return null;
  if (dataIr?.kind === "bytes" && dataIr.elem === "u8") {
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
    const data = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, BYTES_U8);
    if (promise) {
      // appendFile appends; writeFile truncates first. Both take byte data
      // (Node writes the bytes as given), and the pair differs exactly as
      // their string forms do.
      return {
        kind: "libCall",
        fn: append ? "fsp.appendFileBytes" : "fsp.writeFileBytes",
        args: [path, data],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: append ? "fs.appendFileSyncBytes" : "fs.writeFileSyncBytes",
      args: [path, data],
      type: VOID,
      loc,
    };
  }
  return lowerFsWriteDataCall(lowerer, expr, promise, append, loc);
}

/** The same two writes over a data argument whose static type does not pin
 * down a view kind: the bytes are the view's own, whatever element it holds
 * and whatever buffer backs it. */
function lowerFsWriteDataCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  promise: boolean,
  append: boolean,
  loc: SrcLoc,
): IrExpr {
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const data = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, DYN);
  const fn: IrLibFn = promise
    ? append
      ? "fsp.appendFileData"
      : "fsp.writeFileData"
    : append
      ? "fs.appendFileSyncData"
      : "fs.writeFileSyncData";
  return {
    kind: "libCall",
    fn,
    args: [path, data],
    type: promise ? { kind: "promise", inner: VOID } : VOID,
    loc,
  };
}

// The writeFileSync(fd, data[, "utf8"]) form — Node accepts a file
// descriptor where it accepts a path (write to a descriptor openSync
// returned, the descriptor staying open: closeSync owns its lifetime).
// Routed by the ARGUMENT's static type, like readFileSync(fd).
export function lowerFsWriteDescriptorCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const supported = "string, Buffer, TypedArray or DataView data with an optional utf8 encoding";
  const dataNode = expr.arguments.nodes[1]!;
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
  const dataIsString = dataIr?.kind === "string";
  if (expr.arguments.nodes.length > 3) {
    lowerer.noLowering(
      `writeFileSync(fd) with ${expr.arguments.nodes.length} arguments`,
      expr,
      supported,
    );
  }
  const encodingNode = expr.arguments.nodes[2];
  if (encodingNode !== undefined) {
    // Node reads the third argument over the descriptor too (its encoding
    // and signal validation, the flush flag, and — for string data written
    // as utf8 — the flag and mode ladders), so only an encoding that
    // changes nothing is accepted here; every other value keeps the fence.
    const encodingType = lowerer.typeOf(encodingNode);
    if (
      !encodingType.isStringLiteralType() ||
      (encodingType.value !== "utf8" && encodingType.value !== "utf-8")
    ) {
      lowerer.noLowering(
        "writeFileSync(fd) with an options argument",
        encodingNode,
        'the lowered descriptor form is writeFileSync(fd, data) and writeFileSync(fd, data, "utf8"); Node\'s option record over a descriptor (a non-utf8 encoding, flush, signal, or the flag and mode the utf8 fast path parses) has no lowering yet',
      );
    }
  }
  const fd = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64);
  return {
    kind: "libCall",
    fn: dataIsString ? "fs.writeFileSyncFd" : "fs.writeFileSyncFdData",
    args: [fd, lowerer.lowerExprExpecting(dataNode, dataIsString ? STRING : DYN)],
    type: VOID,
    loc,
  };
}

export function lowerFsWriteOptionsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  promiseWriteOptions: boolean,
): IrExpr {
  const optsNode = expr.arguments.nodes[2]!;
  const operation = promiseWriteOptions ? "fs.promises.writeFile" : "writeFileSync";
  /** The two-argument unit of each data kind, the { mode } unit and the
   * { mode, flag } unit. A Uint8Array/Buffer data argument takes the byte
   * twins of all three (the flag unit carries the mode too, so the
   * mode-only byte form passes exclusive = 0). */
  const plainFn: IrLibFn = promiseWriteOptions ? "fsp.writeFile" : "fs.writeFileSync";
  const modeFn: IrLibFn = promiseWriteOptions ? "fsp.writeFileMode" : "fs.writeFileModeSync";
  const flagsFn: IrLibFn = promiseWriteOptions ? "fsp.writeFileFlags" : "fs.writeFileFlagsSync";
  const bytesPlainFn: IrLibFn = promiseWriteOptions
    ? "fsp.writeFileBytes"
    : "fs.writeFileSyncBytes";
  const bytesFlagsFn: IrLibFn = promiseWriteOptions
    ? "fsp.writeFileBytesFlags"
    : "fs.writeFileSyncBytesFlags";
  const dataPlainFn: IrLibFn = promiseWriteOptions ? "fsp.writeFileData" : "fs.writeFileSyncData";
  const dataFlagsFn: IrLibFn = promiseWriteOptions
    ? "fsp.writeFileDataFlags"
    : "fs.writeFileSyncDataFlags";
  const resultType: IrType = promiseWriteOptions ? { kind: "promise", inner: VOID } : VOID;
  type WriteOptionValue = { kind: "effect" | "mode"; value: IrExpr };
  /** The data argument's mapped type: a string, u8 bytes, a union of
   * exactly those arms (a `string | Uint8Array` payload, which Node writes
   * as text or as raw bytes accordingly), or anything else — a typed array
   * of another element, the ArrayBufferView alias, a checked-dynamic value
   * — which takes the checked-data write. */
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!));
  const unionArms =
    dataIr?.kind === "union" ? (lowerer.unions.get(dataIr.unionId)?.arms ?? null) : null;
  const unionWriteData =
    unionArms !== null &&
    unionArms.some((arm) => arm.kind === "string") &&
    unionArms.some((arm) => arm.kind === "bytes" && arm.elem === "u8") &&
    unionArms.every((arm) => arm.kind === "string" || (arm.kind === "bytes" && arm.elem === "u8"))
      ? { type: dataIr as Extract<IrType, { kind: "union" }>, arms: unionArms }
      : null;
  const dataKind: "string" | "bytes" | "union" | "data" =
    dataIr?.kind === "string"
      ? "string"
      : dataIr?.kind === "bytes" && dataIr.elem === "u8"
        ? "bytes"
        : unionWriteData
          ? "union"
          : "data";
  /** `flag: "w"` is the plain truncate-or-create write; `flag: "wx"` is
   * open(2)'s O_EXCL (EEXIST when the path exists). Both are literals, so
   * the bit is known here and carries no evaluation of its own. */
  let exclusive = false;
  let sawFlag = false;
  /** The write issuing one arm's data: `kind` picks the string, byte or
   * checked-data unit. `path` and `data` are the staged operands. */
  const armWrite = (
    path: IrExpr,
    data: IrExpr,
    kind: "string" | "bytes" | "data",
    mode: IrExpr | null,
  ): IrExpr => {
    // Node's default creation mode when only the flag is given.
    const modeArg: IrExpr = mode ?? { kind: "numLit", value: 0o666, type: F64, loc };
    // The checked-data unit carries the same mode and flag pair as the byte
    // one, so the mode-only form passes exclusive = 0.
    const flagFn: IrLibFn =
      kind === "data" ? dataFlagsFn : kind === "bytes" ? bytesFlagsFn : flagsFn;
    const plain: IrLibFn =
      kind === "data" ? dataPlainFn : kind === "bytes" ? bytesPlainFn : plainFn;
    if (sawFlag)
      return {
        kind: "libCall",
        fn: flagFn,
        args: [path, data, modeArg, { kind: "numLit", value: exclusive ? 1 : 0, type: F64, loc }],
        type: resultType,
        loc,
      };
    if (mode !== null)
      return kind === "string"
        ? { kind: "libCall", fn: modeFn, args: [path, data, mode], type: resultType, loc }
        : {
            kind: "libCall",
            fn: flagFn,
            args: [path, data, mode, { kind: "numLit", value: 0, type: F64, loc }],
            type: resultType,
            loc,
          };
    return { kind: "libCall", fn: plain, args: [path, data], type: resultType, loc };
  };
  /** The write over a `string | Uint8Array` data argument: the tag picks
   * the string or the byte unit, the same dispatch lowerStringOrBytesWrite
   * lifts for the two-argument forms. The operands are already staged in
   * locals here, so the dispatch is a plain if/else inside the write's own
   * expression (the promise form keeps its result in a local). */
  const unionWrite = (
    pathLocal: { id: string; type: IrType },
    dataLocal: { id: string; type: IrType },
    mode: IrExpr | null,
  ): Extract<IrExpr, { kind: "seqExpr" }> => {
    const unionType = unionWriteData!.type;
    const arms = unionWriteData!.arms;
    const pathRef = varRef(pathLocal.id, pathLocal.type, loc);
    const dataRef = varRef(dataLocal.id, dataLocal.type, loc);
    const narrow = (tag: number, type: IrType): IrExpr => ({
      kind: "unionNarrow",
      unionId: unionType.unionId,
      tag,
      value: dataRef,
      type,
      loc,
    });
    const isTag = (tag: number): IrExpr => ({
      kind: "unionIsTag",
      unionId: unionType.unionId,
      tag,
      negated: false,
      value: dataRef,
      type: BOOL,
      loc,
    });
    if (promiseWriteOptions) {
      // The promise form picks its arm with a `ternary` chain: exactly one
      // arm evaluates, and the chosen promise reaches the await as an
      // ordinary expression value. A hidden local declared inside an `if`
      // arm does not outlive the arm — an awaited promise held in one was
      // released before the await retained it, a use-after-free that only
      // the sanitizer lane observed.
      let picked: IrExpr | null = null;
      for (let tag = arms.length - 1; tag >= 0; tag--) {
        const arm = arms[tag]!;
        const write = armWrite(
          pathRef,
          narrow(tag, arm),
          arm.kind === "bytes" ? "bytes" : "string",
          mode,
        );
        picked =
          picked === null
            ? write
            : {
                kind: "ternary",
                cond: isTag(tag),
                then: write,
                else_: picked,
                type: resultType,
                loc,
              };
      }
      return { kind: "seqExpr", stmts: [], result: picked!, type: resultType, loc };
    }
    // The synchronous form has no value to carry out: each arm's write is a
    // statement, and the last arm is the chain's else.
    let chain: IrStmt[] | null = null;
    for (let tag = arms.length - 1; tag >= 0; tag--) {
      const arm = arms[tag]!;
      const write = armWrite(
        pathRef,
        narrow(tag, arm),
        arm.kind === "bytes" ? "bytes" : "string",
        mode,
      );
      const body: IrStmt[] = [{ kind: "exprStmt", expr: write, loc }];
      chain =
        chain === null ? body : [{ kind: "if", loc, cond: isTag(tag), then: body, else_: chain }];
    }
    return {
      kind: "seqExpr",
      stmts: chain ?? [],
      result: { kind: "libCall", fn: "console.noop", args: [], type: VOID, loc },
      type: resultType,
      loc,
    };
  };
  // The runtime needs only `mode`, but every source option value is an
  // ordinary JS expression. Stage path/data and then evaluate the option
  // values in object-literal order before issuing the write; otherwise a
  // call/getter statically typed as the accepted utf8 literal can vanish.
  const finishWrite = (optionValues: WriteOptionValue[]): IrExpr => {
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
    const dataNode = expr.arguments.nodes[1]!;
    const dataIrForLocal: IrType =
      dataKind === "bytes"
        ? BYTES_U8
        : dataKind === "union"
          ? unionWriteData!.type
          : dataKind === "data"
            ? DYN
            : STRING;
    const pathLocal = lowerer.declareHiddenLocal("%writePath", STRING);
    const dataLocal = lowerer.declareHiddenLocal("%writeData", dataIrForLocal);
    const stmts: IrStmt[] = [
      { kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc },
      {
        kind: "varDecl",
        localId: dataLocal.id,
        init: lowerer.lowerExprExpecting(dataNode, dataIrForLocal),
        loc: locOf(dataNode),
      },
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
    if (dataKind === "union") {
      const result = unionWrite(pathLocal, dataLocal, mode);
      return {
        kind: "seqExpr",
        stmts: [...stmts, ...result.stmts],
        result: result.result,
        type: resultType,
        loc,
      };
    }
    const result = armWrite(
      varRef(pathLocal.id, pathLocal.type, loc),
      varRef(dataLocal.id, dataLocal.type, loc),
      dataKind === "bytes" ? "bytes" : dataKind === "string" ? "string" : "data",
      mode,
    );
    return { kind: "seqExpr", stmts, result, type: resultType, loc };
  };
  // The bare-encoding spelling — writeFileSync(p, data, "utf-8") — is
  // the options record's encoding key alone: utf8 is what the runtime
  // writes anyway, so the data takes the plain write of its own shape. Any
  // OTHER encoding name changes bytes and keeps the fence below; over byte
  // data no name changes anything (Node never decodes a Buffer), but the
  // declarations only spell the utf8 names there, so the same test serves.
  {
    const t = lowerer.typeOf(optsNode);
    if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) {
      return finishWrite([{ kind: "effect", value: lowerer.lowerExprExpecting(optsNode, STRING) }]);
    }
  }
  const optionValues: WriteOptionValue[] = [];
  // The options argument may be a const BINDING (`const OPTS =
  // {encoding: "utf-8", mode: 0o600} as const`, shared by every write of
  // a file): the literal behind it is the options record. Resolved only
  // through type casts and a never-reassigned const, and only when every
  // value is a literal — the const evaluated them once, so staging them
  // again at the write site is the same evaluation.
  const optsLiteral = optionsLiteralOf(lowerer, optsNode);
  let ok = optsLiteral !== null;
  if (optsLiteral !== null) {
    for (const p of optsLiteral.properties.nodes) {
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
        // Node's disposition flag changes whether an existing file is
        // truncated: "w" is the default write, "wx" the exclusive create.
        // Every other flag (append "a"/"as", synchronous "ws", ...) writes
        // different bytes and keeps the fence by name.
        const t = lowerer.typeOf(m.value);
        if (!t.isStringLiteralType() || (t.value !== "w" && t.value !== "wx")) {
          lowerer.noLowering(
            `${operation} with the flag option`,
            p,
            'the lowered flags are "w" (the default truncate-or-create) and "wx" (O_EXCL: EEXIST when the path exists); other flags write different bytes',
          );
        }
        exclusive = t.value === "wx";
        sawFlag = true;
        optionValues.push({ kind: "effect", value: lowerer.lowerExprExpecting(m.value, STRING) });
      } else {
        // The options-record stance: documented keys with no lowering
        // fence by name; undocumented keys drop like Node.
        fenceOrDropOptionKey(
          lowerer,
          p,
          m.name,
          operation,
          FS_WRITE_FILE_DOCUMENTED_OPTIONS,
          'the supported options are { mode: <number | octal string>, encoding: "utf8", flag: "w" | "wx" }',
        );
      }
    }
  }
  if (!ok) {
    lowerer.noLowering(
      `${operation} with 3 arguments`,
      optsNode,
      'the supported options are { mode: <number | octal string>, encoding: "utf8", flag: "w" | "wx" }',
    );
  }
  return finishWrite(optionValues);
}

/** writeFileSync/appendFileSync with the options the plain forms do not
 * cover: an encoding other than utf8, a flag from Node's wider table (or
 * open(2) bits), a Buffer/TypedArray data argument, or any options at all on
 * appendFileSync (whose default flag is "a"). Answers null when the record is
 * one the plain-write lowerings already handle, so their IR is unchanged.
 *
 * The data is encoded at the call (Node's Buffer.from(data, encoding)); the
 * flag decides whether an existing file is truncated, appended to or left
 * alone. scr_fs_flags.c parses the flag table, runs stringToFlags over a
 * number or an unpinned value, and validates the encoding, flag and mode in
 * Node's order, so the option values may be computed at the call: each is
 * staged in source order into a hidden local. */
export function lowerFsSyncWriteOptionsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  member: string,
): IrExpr | null {
  const append = member === "appendFileSync";
  const operation = append ? "appendFileSync" : "writeFileSync";
  const optsNode = expr.arguments.nodes[2]!;
  const dataNode = expr.arguments.nodes[1]!;
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
  const dataKind: "string" | "bytes" | "data" =
    dataIr?.kind === "string"
      ? "string"
      : dataIr?.kind === "bytes" && dataIr.elem === "u8"
        ? "bytes"
        : "data";
  // The plain forms cover utf8 string data with no flag (writeFileSync) or
  // the "w"/"wx" pair; those keep the IR they always had.
  let plain = !append;
  // A mode whose static type is not a number — an octal string, or a value
  // the call site did not pin down — takes the runtime's parseFileMode
  // ladder through a dynamic mode slot instead of the numeric one.
  let modeDyn = false;
  // The same for a flag whose static type is not a string: a number is
  // open(2) bits, and a value the call site did not pin down runs
  // stringToFlags at the call's run time.
  let flagDyn = false;
  const optionValues: {
    kind: "mode" | "encoding" | "flag";
    node?: ts.Expression;
    ir?: IrExpr;
  }[] = [];
  const optsType = lowerer.typeOf(optsNode);
  // A stored options record (a const, an argument, a call's result) whose
  // fields are a subset of { mode, encoding, flag }: the record is
  // evaluated once at the call, where Node evaluates the argument.
  const stored =
    optsType.isStringLiteralType() || optionsLiteralOf(lowerer, optsNode) !== null
      ? null
      : writeOptionsRecord(lowerer, optsNode);
  if (optsType.isStringLiteralType()) {
    // The bare-encoding spelling — writeFileSync(p, data, "latin1") — is
    // the options record's encoding key alone.
    if (!append && (optsType.value === "utf8" || optsType.value === "utf-8")) return null;
    optionValues.push({ kind: "encoding", node: optsNode });
    plain = false;
  } else if (stored !== null) {
    // Field types decide the slots: a record field is never a literal, so
    // the encoding takes the runtime's name check and an unpinned mode or
    // flag takes the parseFileMode / stringToFlags ladders.
    plain = false;
    if (stored.mode !== undefined && stored.mode.kind !== "f64") modeDyn = true;
    if (stored.flag !== undefined && stored.flag.kind !== "string") flagDyn = true;
  } else {
    const literal = optionsLiteralOf(lowerer, optsNode);
    if (literal === null) return null;
    for (const property of literal.properties.nodes) {
      const m = optionMember(property);
      if (!m) return null;
      if (m.name === "mode") {
        // Node's parseFileMode: a number goes through validateUint32, an
        // octal string parses base 8, and a nullish value is the 0o666
        // default. Only the numeric spelling keeps the numeric slot; the
        // others run the ladder at the call's run time.
        if (fsArgKind(lowerer, m.value) !== "number") {
          modeDyn = true;
          plain = false;
        }
        optionValues.push({ kind: "mode", node: m.value });
      } else if (m.name === "encoding") {
        // The runtime validates and decodes the name (Node's order:
        // encoding, then flag, then mode, then the path), so a value
        // computed at the call site works like a literal one.
        const t = lowerer.typeOf(m.value);
        if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) plain = false;
        optionValues.push({ kind: "encoding", node: m.value });
      } else if (m.name === "flag") {
        // A flag name the call site spelled is parsed by the flag table at
        // the call; a number is open(2) bits and anything else unpinned
        // takes the dynamic slot, where the runtime runs Node's
        // `options.flag || default` and stringToFlags.
        const t = lowerer.typeOf(m.value);
        if (!t.isStringLiteralType() || (t.value !== "w" && t.value !== "wx")) plain = false;
        if (fsArgKind(lowerer, m.value) !== "string") flagDyn = true;
        optionValues.push({ kind: "flag", node: m.value });
      } else {
        // The options-record stance: documented keys with no lowering
        // fence by name; undocumented keys drop like Node.
        fenceOrDropOptionKey(
          lowerer,
          property,
          m.name,
          operation,
          FS_WRITE_FILE_DOCUMENTED_OPTIONS,
          "the supported options are { mode: <number | octal string>, encoding: <BufferEncoding>, flag: <open(2) flag name> }",
        );
      }
    }
  }
  if (dataKind !== "string") plain = false;
  if (plain) return null;
  // A dynamic flag rides the dynamic-mode family, whose flag slot takes a
  // dynamic value as well. A numeric mode staged with it is boxed into the
  // dynamic mode slot and runs the mode ladder's validateUint32 arm, the
  // same check the numeric slot makes.
  if (flagDyn) modeDyn = true;
  const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
  const data = lowerer.lowerExprExpecting(
    dataNode,
    dataKind === "bytes" ? BYTES_U8 : dataKind === "string" ? STRING : DYN,
  );
  const pathLocal = lowerer.declareHiddenLocal("%writePath", STRING);
  const dataLocal = lowerer.declareHiddenLocal("%writeData", data.type);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc },
    { kind: "varDecl", localId: dataLocal.id, init: data, loc: data.loc },
  ];
  // Every option value is an ordinary expression: lower it in object-literal
  // order into a hidden local, so a call or getter runs exactly once, where
  // Node's argument evaluation runs it. The dynamic slots take the defaults
  // boxed, since the call reads both of them through dynamic parameters.
  const box = (value: IrExpr): IrExpr =>
    modeDyn ? { kind: "dynFrom", value, type: DYN, loc } : value;
  let mode: IrExpr = box(numLit(0o666, loc));
  let encoding: IrExpr = strLit("utf8", loc);
  let flag: IrExpr = box(strLit(append ? "a" : "w", loc));
  // A stored options record is evaluated whole after the path and the data,
  // where Node evaluates the third argument, then read field by field.
  if (stored !== null) {
    const local = lowerer.declareHiddenLocal("%writeOptions", stored.type);
    stmts.push({ kind: "varDecl", localId: local.id, init: stored.init, loc: stored.init.loc });
    const obj = varRef(local.id, local.type, loc);
    if (stored.mode !== undefined)
      optionValues.push({
        kind: "mode",
        ir: writeOptionFieldValue(
          lowerer,
          stored.shapeId,
          obj,
          "mode",
          stored.mode,
          modeDyn ? "dyn" : "number",
          box(numLit(0o666, loc)),
          loc,
        ),
      });
    if (stored.encoding !== undefined)
      optionValues.push({
        kind: "encoding",
        ir: writeOptionFieldValue(
          lowerer,
          stored.shapeId,
          obj,
          "encoding",
          stored.encoding,
          "string",
          strLit("utf8", loc),
          loc,
        ),
      });
    if (stored.flag !== undefined)
      optionValues.push({
        kind: "flag",
        ir: writeOptionFieldValue(
          lowerer,
          stored.shapeId,
          obj,
          "flag",
          stored.flag,
          modeDyn ? "dyn" : "string",
          box(strLit(append ? "a" : "w", loc)),
          loc,
        ),
      });
  }
  for (const option of optionValues) {
    const type =
      option.kind === "mode"
        ? modeDyn
          ? DYN
          : F64
        : option.kind === "flag" && modeDyn
          ? DYN
          : STRING;
    const slot = lowerer.declareHiddenLocal(
      option.kind === "mode"
        ? "%writeMode"
        : `%write${option.kind === "flag" ? "Flag" : "Encoding"}`,
      type,
    );
    stmts.push({
      kind: "varDecl",
      localId: slot.id,
      init: option.ir ?? lowerer.lowerExprExpecting(option.node!, type),
      loc: option.ir?.loc ?? locOf(option.node!),
    });
    const ref = varRef(slot.id, slot.type, loc);
    if (option.kind === "mode") mode = ref;
    else if (option.kind === "flag") flag = ref;
    else encoding = ref;
  }
  const pathRef = varRef(pathLocal.id, pathLocal.type, loc);
  const dataRef = varRef(dataLocal.id, dataLocal.type, loc);
  const fn: IrLibFn = modeDyn
    ? dataKind === "bytes"
      ? append
        ? "fs.appendFileBytesOptionsDynModeSync"
        : "fs.writeFileBytesOptionsDynModeSync"
      : dataKind === "data"
        ? append
          ? "fs.appendFileDataOptionsDynModeSync"
          : "fs.writeFileDataOptionsDynModeSync"
        : append
          ? "fs.appendFileOptionsDynModeSync"
          : "fs.writeFileOptionsDynModeSync"
    : dataKind === "bytes"
      ? append
        ? "fs.appendFileBytesOptionsSync"
        : "fs.writeFileBytesOptionsSync"
      : dataKind === "data"
        ? append
          ? "fs.appendFileDataOptionsSync"
          : "fs.writeFileDataOptionsSync"
        : append
          ? "fs.appendFileOptionsSync"
          : "fs.writeFileOptionsSync";
  // Node validates the encoding name for Buffer data too, then ignores it.
  const args: IrExpr[] = [pathRef, dataRef, encoding, mode, flag];
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn, args, type: VOID, loc },
    type: VOID,
    loc,
  };
}

/** fs.appendFileSync(p, data, options): Node's append with an options
 * record. Only the encoding lowers — the runtime appends the same utf8
 * bytes Node does — over a string, a view or a value whose type the call
 * site did not pin down; `mode` (creation only) and the disposition flags
 * (`"a"` is the default, anything else appends differently) keep their
 * fence. */
export function lowerFsAppendOptionsCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr {
  const optsNode = expr.arguments.nodes[2]!;
  const supported = 'the supported options are { encoding: "utf8" }';
  // A Buffer carries its own bytes, so the encoding name says nothing about
  // them (Node never looks it up); a `string | Uint8Array` payload takes the
  // same tag dispatch the two-argument forms use.
  const dataNode = expr.arguments.nodes[1]!;
  const dataIr = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
  const appendArms =
    dataIr?.kind === "union" ? (lowerer.unions.get(dataIr.unionId)?.arms ?? null) : null;
  const unionArms =
    appendArms !== null &&
    appendArms.every((arm) => arm.kind === "string" || (arm.kind === "bytes" && arm.elem === "u8"))
      ? appendArms
      : null;
  const bytesData = dataIr?.kind === "bytes" && dataIr.elem === "u8";
  /** Data the static type does not pin down (another element, the
   * ArrayBufferView alias, a checked-dynamic value) appends through the
   * checked-data unit, which validates and writes a string or a view. */
  const dataWrite = !bytesData && dataIr?.kind !== "string" && unionArms === null;
  const dataType: IrType =
    unionArms !== null
      ? (dataIr as Extract<IrType, { kind: "union" }>)
      : bytesData
        ? BYTES_U8
        : dataWrite
          ? DYN
          : STRING;
  const appendFn: IrLibFn = dataWrite
    ? "fs.appendFileSyncData"
    : bytesData
      ? "fs.appendFileSyncBytes"
      : "fs.appendFileSync";
  const plainAppend = (): IrExpr =>
    unionArms !== null
      ? lowerStringOrBytesWrite(
          lowerer,
          expr,
          dataIr as Extract<IrType, { kind: "union" }>,
          unionArms,
          true,
        )
      : {
          kind: "libCall",
          fn: appendFn,
          args: [
            lowerFsPath(lowerer, expr.arguments.nodes[0]!),
            lowerer.lowerExprExpecting(dataNode, dataType),
          ],
          type: VOID,
          loc,
        };
  // The bare encoding spelling names an ordinary expression, not just a
  // literal: Node evaluates it — side effects and exceptions included —
  // after the path and the data and before the write, even though the value
  // only has to be utf8. Stage the two operands so the encoding expression
  // lands in that order; otherwise a call statically typed as "utf8" fails
  // to run, or fails to throw.
  const appendAfterEncoding = (encoding: ts.Expression): IrExpr => {
    const pathLocal = lowerer.declareHiddenLocal("%appendPath", STRING);
    const dataLocal = lowerer.declareHiddenLocal("%appendData", dataType);
    const path = varRef(pathLocal.id, STRING, loc);
    const data = varRef(dataLocal.id, dataType, loc);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: pathLocal.id,
          init: lowerFsPath(lowerer, expr.arguments.nodes[0]!),
          loc,
        },
        {
          kind: "varDecl",
          localId: dataLocal.id,
          init: lowerer.lowerExprExpecting(dataNode, dataType),
          loc: locOf(dataNode),
        },
        {
          kind: "exprStmt",
          expr: lowerer.lowerExprExpecting(encoding, STRING),
          loc: locOf(encoding),
        },
      ],
      result:
        unionArms !== null
          ? lowerStringOrBytesWrite(
              lowerer,
              expr,
              dataIr as Extract<IrType, { kind: "union" }>,
              unionArms,
              true,
              { path, data },
            )
          : {
              kind: "libCall",
              fn: appendFn,
              args: [path, data],
              type: VOID,
              loc,
            },
      type: VOID,
      loc,
    };
  };
  const t = lowerer.typeOf(optsNode);
  if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8"))
    return appendAfterEncoding(optsNode);
  const literal = optionsLiteralOf(lowerer, optsNode);
  if (literal !== null) {
    let encodingOnly = true;
    let encoding: ts.Expression | null = null;
    for (const property of literal.properties.nodes) {
      const member = optionMember(property);
      if (!member || member.name !== "encoding") {
        lowerer.noLowering(
          `fs.appendFileSync with the ${member ? `'${member.name}'` : "spread"} option`,
          property,
          supported,
        );
        encodingOnly = false;
        break;
      }
      const value = lowerer.typeOf(member.value);
      if (!value.isStringLiteralType() || (value.value !== "utf8" && value.value !== "utf-8")) {
        encodingOnly = false;
        break;
      }
      encoding = member.value;
    }
    // The options record is evaluated at the write site, as Node evaluates it:
    // the encoding member's expression runs after the path and the data, so a
    // call or getter behind a statically "utf8" value has its effects and
    // exceptions, rather than being read for its type and dropped.
    // A record with no member has no expression to evaluate.
    if (encodingOnly) return encoding === null ? plainAppend() : appendAfterEncoding(encoding);
  }
  lowerer.noLowering("fs.appendFileSync with 3 arguments", optsNode, supported);
  return plainAppend();
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
  // `({...} as const)` is the literal: the parentheses go with the assertion.
  const unwrap = (expr: ts.Expression): ts.Expression => withoutParenthesesTypeWrappers(expr);
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

/** A mode or flag field may be absent (its nullish arm answers the write's
 * default) or one of the two spellings the runtime's parseFileMode /
 * stringToFlags ladders read; an encoding field is a name. */
const WRITE_MODE_FIELD_ARMS: readonly IrType[] = [F64, STRING];
const WRITE_ENCODING_FIELD_ARMS: readonly IrType[] = [STRING];

/** Whether a stored options field's type is one the dynamic slot can carry:
 * exactly one of `arms`, optionally with one nullish arm the default
 * absorbs. */
function writeOptionFieldOk(lowerer: Lowerer, ft: IrType, arms: readonly IrType[]): boolean {
  const absent = (t: IrType): boolean => typeEquals(t, UNDEFINED_T) || typeEquals(t, NULL_T);
  if (ft.kind !== "union") return arms.some((a) => typeEquals(ft, a));
  const unionArms = lowerer.unions.get(ft.unionId)?.arms;
  if (!unionArms || unionArms.length === 0) return false;
  if (unionArms.filter(absent).length > 1) return false;
  if (!unionArms.every((a) => absent(a) || arms.some((k) => typeEquals(a, k)))) return false;
  return unionArms.some((a) => arms.some((k) => typeEquals(a, k)));
}

/** The options argument of a write whose value is not an object literal but
 * whose type IS an object record with no more than the documented mode,
 * encoding and flag keys: the record is staged once and its fields read
 * from it. Null when any field's type cannot ride its slot (a name the
 * value could never be, a key this lowering does not implement), so the
 * caller keeps its fence. */
function writeOptionsRecord(
  lowerer: Lowerer,
  optsNode: ts.Expression,
): {
  init: IrExpr;
  type: IrType;
  shapeId: string;
  mode?: IrType;
  encoding?: IrType;
  flag?: IrType;
} | null {
  const opts = lowerer.lowerExpr(optsNode);
  if (opts.type.kind !== "record") return null;
  const shapeId = opts.type.shapeId;
  const shape = lowerer.shapes.get(shapeId);
  if (!shape || shape.tuple === true || shape.indexValue !== undefined) return null;
  const out: {
    init: IrExpr;
    type: IrType;
    shapeId: string;
    mode?: IrType;
    encoding?: IrType;
    flag?: IrType;
  } = { init: opts, type: opts.type, shapeId };
  for (const field of shape.fields) {
    if (field.optional === true) return null;
    if (field.name === "mode") {
      if (!writeOptionFieldOk(lowerer, field.type, WRITE_MODE_FIELD_ARMS)) return null;
      out.mode = field.type;
    } else if (field.name === "flag") {
      if (!writeOptionFieldOk(lowerer, field.type, WRITE_MODE_FIELD_ARMS)) return null;
      out.flag = field.type;
    } else if (field.name === "encoding") {
      if (!writeOptionFieldOk(lowerer, field.type, WRITE_ENCODING_FIELD_ARMS)) return null;
      out.encoding = field.type;
    } else {
      // A key this lowering does not implement (flush, signal, or anything
      // undocumented) keeps the fence.
      return null;
    }
  }
  return out;
}

/** A stored options record's field read. A field whose type carries a
 * nullish arm answers `dflt` there (Node's `?? default`); every other arm
 * is narrowed by its tag and, for the dynamic slot, boxed for the runtime
 * ladder. `writeOptionsRecord` only hands over types this can carry. */
function writeOptionFieldValue(
  lowerer: Lowerer,
  shapeId: string,
  obj: IrExpr,
  name: string,
  ft: IrType,
  slot: "number" | "string" | "dyn",
  dflt: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const read: IrExpr = { kind: "recordGet", obj, shapeId, field: name, type: ft, loc };
  if (slot === "number") return read;
  if (ft.kind !== "union") {
    if (slot === "string") return read;
    return ft.kind === "dyn" ? read : { kind: "dynFrom", value: read, type: DYN, loc };
  }
  const arms = lowerer.unions.get(ft.unionId)!.arms;
  const kept = arms.filter((a) => !typeEquals(a, UNDEFINED_T) && !typeEquals(a, NULL_T));
  const narrowed = (arm: IrType): IrExpr => ({
    kind: "unionNarrow",
    unionId: ft.unionId,
    tag: lowerer.armTag(ft.unionId, arm),
    value: read,
    type: arm,
    loc,
  });
  const box = (value: IrExpr): IrExpr => ({ kind: "dynFrom", value, type: DYN, loc });
  let held: IrExpr;
  if (slot === "string") held = narrowed(STRING);
  else if (kept.length === 1) held = box(narrowed(kept[0]!));
  else
    held = {
      kind: "ternary",
      cond: {
        kind: "unionIsTag",
        unionId: ft.unionId,
        tag: lowerer.armTag(ft.unionId, kept[0]!),
        negated: false,
        value: read,
        type: BOOL,
        loc,
      },
      then: box(narrowed(kept[0]!)),
      else_: box(narrowed(kept[1]!)),
      type: DYN,
      loc,
    };
  const absent = lowerer.armTag(ft.unionId, UNDEFINED_T);
  const nullish = absent >= 0 ? absent : lowerer.armTag(ft.unionId, NULL_T);
  if (kept.length === arms.length) return held;
  return {
    kind: "ternary",
    cond: {
      kind: "unionIsTag",
      unionId: ft.unionId,
      tag: nullish,
      negated: false,
      value: read,
      type: BOOL,
      loc,
    },
    then: dflt,
    else_: held,
    type: dflt.type,
    loc,
  };
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
  // a dyn path rides a validated string extraction: in a JavaScript
  // source Node's getValidatedPath (dyn.validateFsPath, which throws
  // ERR_INVALID_ARG_TYPE for a non-path), in a TypeScript source the
  // checked cast. The fd forms (a number argument) and literal-utf8
  // reads keep their existing lowerings.
  const pathV = lowerer.lowerExpr(expr.arguments.nodes[0]!);
  if (pathV.type.kind === "string" || pathV.type.kind === "dyn") {
    const pathArg: IrExpr =
      pathV.type.kind === "dyn"
        ? (jsFsPathValue(lowerer, expr.arguments.nodes[0]!, pathV) ?? {
            kind: "dynCheck",
            value: pathV,
            type: STRING,
            loc,
          })
        : pathV;
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
): { recursive: ts.Expression | null; mode: ts.Expression | null } | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  let recursive: ts.Expression | null = null;
  let mode: ts.Expression | null = null;
  for (const property of node.properties.nodes) {
    const member = optionMember(property);
    if (!member) return null;
    if (member.name === "recursive") recursive = member.value;
    else if (member.name === "mode") mode = member.value;
    else return null;
  }
  return { recursive, mode };
}

/** fs.existsSync(path) where the path value is not statically a string: a
 * Buffer path, an `any`-typed value, a URL, or any other value. Node's
 * existsSync answers false for every path getValidatedPath rejects —
 * anything that is not a string, a Uint8Array or a file: URL — and reports
 * DEP0187 once, which the value form (scr_fs_exists_dyn.c) does. A
 * statically typed Buffer takes the typed entry point (scr_fs_exists_bytes)
 * and every other non-string value takes the value form, which decides the
 * arm at run time; only a plain string argument keeps the typed call. A URL
 * path whose conversion the fs URL machinery already lifted to a string
 * arrives here as a string. Null for a value the value form cannot carry.
 * Node ignores arguments past the first but still evaluates them, so surplus
 * arguments are lowered here rather than dropped.
 */
export function lowerFsExistsValueCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  // A spread would decide the path value at run time, which this form cannot
  // stage; the ordinary call path rejects it.
  if (expr.arguments.nodes.some(ts.isSpreadElement)) return null;
  const arg = expr.arguments.nodes[0];
  const type = arg ? lowerer.mapTypeOf(lowerer.typeOf(arg)) : null;
  const unit = (arm: IrType | null) =>
    arm?.kind === "undefinedT" || arm?.kind === "nullT" || arm?.kind === "void";
  const unitExpr =
    arg !== undefined &&
    (arg.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(arg) && arg.text === "undefined"));
  // A statically typed string (the URL path machinery converts file: URLs to
  // one) keeps the typed entry point.
  if (arg !== undefined && type !== null && type.kind === "string") return null;
  // A null mapped type is `any`/`unknown`: the runtime decides. Everything
  // else must be a value the checked-dynamic form can carry.
  const boxable =
    arg === undefined ||
    type === null ||
    type.kind === "dyn" ||
    typeEquals(type, BYTES_U8) ||
    unit(type) ||
    unitExpr ||
    lowerer.dynConvertible(type);
  if (!boxable) return null;
  // A statically typed Buffer path answers through its own entry point
  // (scr_fs_exists_bytes): the value form would box it, and a fully typed
  // program links no dynamic tier. Every other non-string path keeps the
  // value form, which decides the arm at run time.
  const bytesPath = type !== null && typeEquals(type, BYTES_U8);
  const lowered =
    arg === undefined
      ? dynUndefinedExpr(loc)
      : bytesPath
        ? lowerer.lowerExprExpecting(arg, BYTES_U8)
        : lowerer.lowerExprExpecting(arg, DYN);
  const fn = bytesPath ? "fs.existsSyncBytes" : "fs.existsSyncValue";
  const surplus = expr.arguments.nodes.slice(1);
  if (surplus.length === 0) {
    return { kind: "libCall", fn, args: [lowered], type: BOOL, loc };
  }
  // Stage the path, then evaluate the ignored arguments in source order, so
  // their effects happen before the call and after the argument before them.
  const pathLocal = lowerer.declareHiddenLocal("%existsPath", lowered.type);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: pathLocal.id, init: lowered, loc: lowered.loc },
  ];
  for (const extra of surplus) {
    const e = lowerer.lowerExpr(extra);
    stmts.push({ kind: "exprStmt", expr: e, loc: e.loc });
  }
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "libCall",
      fn,
      args: [varRef(pathLocal.id, lowered.type, loc)],
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}
