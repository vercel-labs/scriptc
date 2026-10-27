import { lowerBuiltinByteInput, errorFirstBytesCallback } from "./arguments.js";
import { dynUndefinedExpr, numLit, varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { isNodeTypesPath } from "../../dts-paths.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  funcOf,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  type SrcLoc,
  STRING,
  VOID,
  ZLIB_STREAM_MODES,
} from "../../../ir/ir.js";

const ZLIB_SYNC_FNS: Readonly<Record<string, IrLibFn | undefined>> = {
  deflateSync: "zlib.deflateSync",
  inflateSync: "zlib.inflateSync",
  deflateRawSync: "zlib.deflateRawSync",
  inflateRawSync: "zlib.inflateRawSync",
  gzipSync: "zlib.gzipSync",
  gunzipSync: "zlib.gunzipSync",
  unzipSync: "zlib.unzipSync",
};

const ZLIB_CALLBACK_FNS: Readonly<Record<string, IrLibFn | undefined>> = {
  deflate: "zlib.deflateCb",
  inflate: "zlib.inflateCb",
  deflateRaw: "zlib.deflateRawCb",
  inflateRaw: "zlib.inflateRawCb",
  gzip: "zlib.gzipCb",
  gunzip: "zlib.gunzipCb",
  unzip: "zlib.unzipCb",
};

/* Node's BROTLI_DECODE and BROTLI_ENCODE modes. */
const BROTLI_DECODE = 8;
const BROTLI_ENCODE = 9;

/** The Brotli one-shots: every form takes the options entries. */
const BROTLI_SYNC_MEMBERS: ReadonlySet<string> = new Set([
  "brotliCompressSync",
  "brotliDecompressSync",
]);
const BROTLI_CALLBACK_MEMBERS: ReadonlySet<string> = new Set([
  "brotliCompress",
  "brotliDecompress",
]);

/** A Brotli mode connects the codec (scr_brotli.c) to the zlib engine
 * before any module initializer runs. */
function noteBrotliMode(lowerer: Lowerer, mode: number, loc: SrcLoc): void {
  if (mode !== BROTLI_DECODE && mode !== BROTLI_ENCODE) return;
  const installs = (stmt: IrStmt): boolean =>
    stmt.kind === "exprStmt" &&
    stmt.expr.kind === "libCall" &&
    stmt.expr.fn === "zlib.brotliInstall";
  if (lowerer.mainPrelude.some(installs)) return;
  lowerer.mainPrelude.push({
    kind: "exprStmt",
    expr: { kind: "libCall", fn: "zlib.brotliInstall", args: [], type: VOID, loc },
    loc,
  });
}

const ZLIB_STREAM_CLASS = "%Transform";
const ZLIB_STREAM_T: IrType = { kind: "object", className: ZLIB_STREAM_CLASS };

/** A zlib data argument, lowered once: Buffer/Uint8Array bytes, a string
 * (UTF-8 encoded here), or a checked-dynamic value (the JS lane's untyped
 * data, which the runtime converts after validating the options — Node's
 * order). Other static types keep the byte-input fence. */
function zlibInput(
  lowerer: Lowerer,
  node: ts.Expression,
  loc: SrcLoc,
): { value: IrExpr; dyn: boolean } {
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "dyn") return { value, dyn: true };
  if (value.type.kind === "bytes" && value.type.elem === "u8") return { value, dyn: false };
  if (value.type.kind === "string") {
    return {
      value: {
        kind: "libCall",
        fn: "buffer.fromStr",
        args: [value, { kind: "strLit", value: "utf8", type: STRING, loc }],
        type: BYTES_U8,
        loc,
      },
      dyn: false,
    };
  }
  lowerer.noLowering(
    `zlib byte input of '${lowerer.fmt(value.type)}' values`,
    node,
    "string and Buffer/Uint8Array values are supported",
  );
}

/** A zlib options argument as the dyn value the runtime ladder reads. */
function zlibOptionsValue(
  lowerer: Lowerer,
  node: ts.Expression,
  what: string,
  loc: SrcLoc,
): IrExpr {
  const raw = lowerer.lowerExpr(node);
  if (raw.type.kind === "dyn") return raw;
  if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
    return { kind: "dynFrom", value: raw, type: DYN, loc };
  }
  lowerer.noLowering(
    `${what} with a '${lowerer.fmt(raw.type)}' options value`,
    node,
    "zlib options are a plain object of numbers, booleans and Buffers",
  );
}

/** `zlib.createGzip(options?)` and `new zlib.Gzip(options?)`: the runtime
 * Transform stream (scr_zlib_stream.c). The options value crosses as a dyn
 * value and is validated at runtime with Node's ladder, so literal and
 * computed options take the same path. */
export function lowerZlibStreamNew(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  mode: number,
  what: string,
  site: ts.Node,
  loc: SrcLoc,
): IrExpr {
  if (args.some(ts.isSpreadElement)) lowerer.noLowering(`${what} with spread arguments`, site);
  if (args.length > 1) {
    lowerer.noLowering(
      `${what} with ${args.length} arguments`,
      args[1]!,
      "the supported form takes one options object",
    );
  }
  const options =
    args[0] !== undefined ? zlibOptionsValue(lowerer, args[0], what, loc) : dynUndefinedExpr(loc);
  noteBrotliMode(lowerer, mode, loc);
  return {
    kind: "libCall",
    fn: "zlib.streamNew",
    args: [numLit(mode, loc), options],
    type: ZLIB_STREAM_T,
    loc,
  };
}

/** The node_zlib_mode of a zlib stream CLASS symbol (`new zlib.Gzip()`,
 * `new Gzip()` through any import spelling) declared by the shipped
 * fallback, or null. */
export function zlibStreamModeOf(
  lowerer: Lowerer,
  symbol: ts.Symbol | null | undefined,
): number | null {
  if (!symbol) return null;
  const alias = lowerer.builtinClassAliasOf(symbol);
  if (alias !== null) return alias.kind === "zlib" ? alias.mode : null;
  const target =
    symbol.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(symbol) : symbol;
  const mode = ZLIB_STREAM_MODES.get(ts.symbolName(target));
  if (mode === undefined) return null;
  return target.declarations.some((d) => ts.isClassDeclaration(d) && isZlibFallbackDecl(lowerer, d))
    ? mode
    : null;
}

function isZlibFallbackDecl(lowerer: Lowerer, d: ts.Node): boolean {
  const file = ts.getSourceFileOfNode(d);
  if (!lowerer.isStdlibFile(file) || isNodeTypesPath(file.fileName)) return false;
  for (let node: ts.Node | undefined = d.parent; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return node.name.text === "zlib" || node.name.text === "node:zlib";
    }
  }
  return false;
}

/** True when `access` names a member the zlib stream base classes declare
 * (bytesWritten, flush, close and reset on ZlibBase; params on Zlib). */
export function isZlibStreamMember(lowerer: Lowerer, access: ts.PropertyAccessExpression): boolean {
  const symbol = lowerer.checker.getSymbolAtLocation(access.name);
  if (!symbol) return false;
  return symbol.declarations.some(
    (d) =>
      d.parent !== undefined &&
      ts.isClassDeclaration(d.parent) &&
      (d.parent.name?.text === "ZlibBase" || d.parent.name?.text === "Zlib") &&
      isZlibFallbackDecl(lowerer, d.parent),
  );
}

/** `stream.bytesWritten` on a zlib stream. */
export function lowerZlibStreamBytesWritten(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(access);
  return {
    kind: "libCall",
    fn: "zlib.streamBytesWritten",
    args: [lowerer.lowerExpr(access.expression)],
    type: F64,
    loc,
  };
}

/** flush/params/close/reset on a zlib stream. Callbacks are () => void,
 * the write-callback rule; numeric operands cross as dyn values for the
 * runtime's range checks. */
export function lowerZlibStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(call);
  const member = access.name.text;
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement)) lowerer.noLowering(`${member} with spread arguments`, call);
  const isFunc = (node: ts.Expression): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "func";
  const callback = (node: ts.Expression): IrExpr => {
    const cb = lowerer.lowerExprExpecting(node, funcOf([], VOID));
    if (cb.type.kind !== "func" || cb.type.params.length > 0) {
      lowerer.noLowering(
        `zlib ${member} callbacks taking arguments`,
        node,
        "() => void callbacks are supported (listen for 'error' to observe failures)",
      );
    }
    return cb;
  };
  const value = (node: ts.Expression | undefined): IrExpr => {
    if (node === undefined) return dynUndefinedExpr(loc);
    const raw = lowerer.lowerExpr(node);
    if (raw.type.kind === "dyn") return raw;
    if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      return { kind: "dynFrom", value: raw, type: DYN, loc };
    }
    lowerer.noLowering(`zlib ${member} with a '${lowerer.fmt(raw.type)}' argument`, node);
  };
  const receiver = (): IrExpr => lowerer.lowerExpr(access.expression);
  const call0 = (fn: IrLibFn, operands: IrExpr[]): IrExpr => ({
    kind: "libCall",
    fn,
    args: operands,
    type: VOID,
    loc,
  });
  const tooMany = (max: number): void => {
    if (args.length > max) lowerer.noLowering(`zlib ${member} with ${args.length} arguments`, call);
  };
  switch (member) {
    case "flush": {
      tooMany(2);
      // flush(cb) moves a function first argument into the callback slot.
      const first = args[0];
      const cbNode = first !== undefined && isFunc(first) ? first : args[1];
      const kindNode = first !== undefined && first !== cbNode ? first : undefined;
      const recv = receiver();
      const kind = value(kindNode);
      return cbNode !== undefined
        ? call0("zlib.streamFlushCb", [recv, kind, callback(cbNode)])
        : call0("zlib.streamFlush", [recv, kind]);
    }
    case "params": {
      tooMany(3);
      const recv = receiver();
      const level = value(args[0]);
      const strategy = value(args[1]);
      return args[2] !== undefined
        ? call0("zlib.streamParamsCb", [recv, level, strategy, callback(args[2])])
        : call0("zlib.streamParams", [recv, level, strategy]);
    }
    case "close": {
      tooMany(1);
      const recv = receiver();
      return args[0] !== undefined
        ? call0("zlib.streamCloseCb", [recv, callback(args[0])])
        : call0("zlib.streamClose", [recv]);
    }
    case "reset":
      tooMany(0);
      return call0("zlib.streamReset", [receiver()]);
    default:
      lowerer.noLowering(`zlib stream member '${member}'`, access);
  }
}

/** node_zlib_mode of each one-shot form (the options-taking runtime entry). */
const ZLIB_ONE_SHOT_MODES: Readonly<Record<string, number | undefined>> = {
  deflateSync: 1,
  inflateSync: 2,
  gzipSync: 3,
  gunzipSync: 4,
  deflateRawSync: 5,
  inflateRawSync: 6,
  unzipSync: 7,
  deflate: 1,
  inflate: 2,
  gzip: 3,
  gunzip: 4,
  deflateRaw: 5,
  inflateRaw: 6,
  unzip: 7,
  brotliDecompressSync: BROTLI_DECODE,
  brotliCompressSync: BROTLI_ENCODE,
  brotliDecompress: BROTLI_DECODE,
  brotliCompress: BROTLI_ENCODE,
};

/** True for a zlib callback one-shot util.promisify converts (deflate,
 * inflate, deflateRaw, inflateRaw, gzip, gunzip, unzip, brotliCompress and
 * brotliDecompress). */
export function isPromisifiedZlibMember(member: string): boolean {
  return ZLIB_CALLBACK_FNS[member] !== undefined || BROTLI_CALLBACK_MEMBERS.has(member);
}

/** A call through `promisify(zlib.gzip)` and the other callback one-shots:
 * `gzipAsync(data, options?)` runs the callback form's work and returns a
 * promise that settles where the callback would run, with the Buffer or the
 * callback form's Error. An options or input error rejects the promise, as
 * the throw inside Node's promisify wrapper does. */
export function lowerPromisifiedZlibCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`the promisified zlib.${member} with spread arguments`, expr);
  }
  if (expr.arguments.nodes.length !== 1 && expr.arguments.nodes.length !== 2) {
    lowerer.noLowering(
      `the promisified zlib.${member} with ${expr.arguments.nodes.length} arguments`,
      expr,
      `the supported forms are ${member}Async(data) and ${member}Async(data, options)`,
    );
  }
  const input = zlibInput(lowerer, expr.arguments.nodes[0]!, loc);
  noteBrotliMode(lowerer, ZLIB_ONE_SHOT_MODES[member]!, loc);
  return {
    kind: "libCall",
    fn: input.dyn ? "zlib.promiseDyn" : "zlib.promise",
    args: [
      numLit(ZLIB_ONE_SHOT_MODES[member]!, loc),
      input.value,
      expr.arguments.nodes[1] !== undefined
        ? zlibOptionsValue(lowerer, expr.arguments.nodes[1], `zlib.${member}`, loc)
        : dynUndefinedExpr(loc),
    ],
    type: { kind: "promise", inner: BYTES_U8 },
    loc,
  };
}

const ZLIB_STREAM_FACTORIES: Readonly<Record<string, number | undefined>> = {
  createDeflate: 1,
  createInflate: 2,
  createGzip: 3,
  createGunzip: 4,
  createDeflateRaw: 5,
  createInflateRaw: 6,
  createUnzip: 7,
  createBrotliDecompress: BROTLI_DECODE,
  createBrotliCompress: BROTLI_ENCODE,
};

export function lowerZlibModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`zlib.${bi.member} with spread arguments`, expr);
  }
  const streamMode = ZLIB_STREAM_FACTORIES[bi.member];
  if (streamMode !== undefined) {
    return lowerZlibStreamNew(
      lowerer,
      expr.arguments.nodes,
      streamMode,
      `zlib.${bi.member}`,
      expr,
      loc,
    );
  }
  if (BROTLI_SYNC_MEMBERS.has(bi.member) || BROTLI_CALLBACK_MEMBERS.has(bi.member)) {
    return lowerBrotliOneShot(lowerer, expr, bi.member, loc);
  }
  const syncFn = ZLIB_SYNC_FNS[bi.member];
  if (syncFn !== undefined) {
    if (expr.arguments.nodes.length === 0 || expr.arguments.nodes.length > 2) {
      lowerer.noLowering(`${bi.member} with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const input = zlibInput(lowerer, expr.arguments.nodes[0]!, loc);
    if (input.dyn) {
      return {
        kind: "libCall",
        fn: "zlib.syncOptsDyn",
        args: [
          numLit(ZLIB_ONE_SHOT_MODES[bi.member]!, loc),
          input.value,
          expr.arguments.nodes[1] !== undefined
            ? zlibOptionsValue(lowerer, expr.arguments.nodes[1], `zlib.${bi.member}`, loc)
            : dynUndefinedExpr(loc),
        ],
        type: BYTES_U8,
        loc,
      };
    }
    if (
      expr.arguments.nodes.length === 2 &&
      (bi.member === "deflateSync" || bi.member === "deflateRawSync" || bi.member === "gzipSync")
    ) {
      const options = expr.arguments.nodes[1]!;
      // A lone literal level keeps the direct compression entry (build-time
      // compression in the native emitters uses it); other options take the
      // runtime option ladder below.
      if (ts.isObjectLiteralExpression(options) && options.properties.nodes.length === 1) {
        const prop = options.properties.nodes[0]!;
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "level"
        ) {
          const value = prop.initializer;
          const level = ts.isNumericLiteral(value)
            ? Number(value.text)
            : ts.isPrefixUnaryExpression(value) &&
                value.operator === ts.SyntaxKind.MinusToken &&
                ts.isNumericLiteral(value.operand)
              ? -Number(value.operand.text)
              : NaN;
          if (Number.isInteger(level) && level >= -1 && level <= 9) {
            return {
              kind: "libCall",
              fn: "zlib.deflateLevelSync",
              args: [
                input.value,
                numLit(
                  bi.member === "deflateSync" ? 0 : bi.member === "deflateRawSync" ? 1 : 2,
                  loc,
                ),
                numLit(level, loc),
              ],
              type: BYTES_U8,
              loc,
            };
          }
        }
      }
    }
    if (expr.arguments.nodes.length === 2) {
      return {
        kind: "libCall",
        fn: "zlib.syncOpts",
        args: [
          numLit(ZLIB_ONE_SHOT_MODES[bi.member]!, loc),
          input.value,
          zlibOptionsValue(lowerer, expr.arguments.nodes[1]!, `zlib.${bi.member}`, loc),
        ],
        type: BYTES_U8,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: syncFn,
      args: [input.value],
      type: BYTES_U8,
      loc,
    };
  }
  const callbackFn = ZLIB_CALLBACK_FNS[bi.member];
  if (callbackFn !== undefined) {
    if (expr.arguments.nodes.length !== 2 && expr.arguments.nodes.length !== 3) {
      lowerer.noLowering(
        `${bi.member} with ${expr.arguments.nodes.length} arguments`,
        expr,
        `${bi.member}(data, callback) and ${bi.member}(data, options, callback) are supported`,
      );
    }
    const input = zlibInput(lowerer, expr.arguments.nodes[0]!, loc);
    const dynData = input.dyn;
    if (expr.arguments.nodes.length === 3 || dynData) {
      // (data, options, callback): Node validates the options before the
      // callback and the input, so the runtime ladder runs first.
      const withOptions = expr.arguments.nodes.length === 3;
      return {
        kind: "libCall",
        fn: dynData ? "zlib.cbOptsDyn" : "zlib.cbOpts",
        args: [
          numLit(ZLIB_ONE_SHOT_MODES[bi.member]!, loc),
          input.value,
          withOptions
            ? zlibOptionsValue(lowerer, expr.arguments.nodes[1]!, `zlib.${bi.member}`, loc)
            : dynUndefinedExpr(loc),
          errorFirstBytesCallback(lowerer, expr.arguments.nodes[withOptions ? 2 : 1]!, "zlib"),
        ],
        type: VOID,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: callbackFn,
      args: [input.value, errorFirstBytesCallback(lowerer, expr.arguments.nodes[1]!, "zlib")],
      type: VOID,
      loc,
    };
  }
  if (bi.member === "crc32") {
    if (expr.arguments.nodes.length < 1 || expr.arguments.nodes.length > 2) {
      lowerer.noLowering(
        `zlib.crc32 with ${expr.arguments.nodes.length} arguments`,
        expr,
        "crc32(data[, initialValue]) is supported",
      );
    }
    return {
      kind: "libCall",
      fn: "zlib.crc32",
      args: [
        lowerBuiltinByteInput(lowerer, expr.arguments.nodes[0]!, loc, "zlib"),
        expr.arguments.nodes[1]
          ? lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, F64)
          : { kind: "numLit", value: 0, type: F64, loc },
      ],
      type: F64,
      loc,
    };
  }
  throw new InternalCompilerError(`unhandled lowered zlib member ${bi.member}`);
}

/** brotliCompressSync(data[, options]), brotliCompress(data[, options],
 * callback) and the decompress pair: the options entries with Node's
 * BROTLI_ENCODE or BROTLI_DECODE mode, an absent options value passing
 * undefined. */
function lowerBrotliOneShot(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  const args = expr.arguments.nodes;
  const mode = ZLIB_ONE_SHOT_MODES[member]!;
  const sync = BROTLI_SYNC_MEMBERS.has(member);
  if (sync ? args.length === 0 || args.length > 2 : args.length !== 2 && args.length !== 3) {
    lowerer.noLowering(
      `zlib.${member} with ${args.length} arguments`,
      expr,
      sync
        ? `${member}(data) and ${member}(data, options) are supported`
        : `${member}(data, callback) and ${member}(data, options, callback) are supported`,
    );
  }
  const input = zlibInput(lowerer, args[0]!, loc);
  const withOptions = sync ? args.length === 2 : args.length === 3;
  const options = withOptions
    ? zlibOptionsValue(lowerer, args[1]!, `zlib.${member}`, loc)
    : dynUndefinedExpr(loc);
  noteBrotliMode(lowerer, mode, loc);
  if (sync) {
    return {
      kind: "libCall",
      fn: input.dyn ? "zlib.syncOptsDyn" : "zlib.syncOpts",
      args: [numLit(mode, loc), input.value, options],
      type: BYTES_U8,
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: input.dyn ? "zlib.cbOptsDyn" : "zlib.cbOpts",
    args: [
      numLit(mode, loc),
      input.value,
      options,
      errorFirstBytesCallback(lowerer, args[withOptions ? 2 : 1]!, "zlib"),
    ],
    type: VOID,
    loc,
  };
}

/** The class name of a zlib stream mode (Node's constructor name). */
export function zlibClassName(mode: number): string {
  for (const [name, m] of ZLIB_STREAM_MODES) if (m === mode) return name;
  return "Zlib";
}

/** `value instanceof zlib.Gzip` (any spelling of the class, aliases
 * included). zlib streams are runtime Transforms: a Transform operand asks
 * the runtime for the stream's mode, and an operand typed as one of
 * Transform's bases (Duplex, Readable, EventEmitter) is first tested for a
 * Transform. Any other static type answers false after the operand
 * evaluates. */
export function lowerZlibInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  mode: number,
  loc: SrcLoc,
): IrExpr {
  const value = lowerer.lowerExpr(expr.left);
  const type = value.type;
  const holdsStream = (className: string): boolean =>
    className === ZLIB_STREAM_CLASS || lowerer.isSubclassOf(ZLIB_STREAM_CLASS, className);
  const arms = type.kind === "union" ? lowerer.unions.get(type.unionId)?.arms : undefined;
  if (
    type.kind === "dyn" ||
    arms?.some((arm) => arm.kind === "object" && holdsStream(arm.className))
  ) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'instanceof zlib.${zlibClassName(mode)}' on an untyped or union value (give the operand a stream type first)`,
    );
  }
  if (type.kind === "object" && holdsStream(type.className)) {
    const isMode = (stream: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "zlib.streamIs",
      args: [stream, numLit(mode, loc)],
      type: BOOL,
      loc,
    });
    if (type.className === ZLIB_STREAM_CLASS) return isMode(value);
    const local = lowerer.declareHiddenLocal("%zlibTest", type);
    const ref = varRef(local.id, type, loc);
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
      result: {
        kind: "logical",
        op: "&&",
        left: {
          kind: "instanceOf",
          value: ref,
          className: ZLIB_STREAM_CLASS,
          type: BOOL,
          loc,
        },
        right: isMode({ kind: "downcast", value: ref, type: ZLIB_STREAM_T, loc }),
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: { kind: "boolLit", value: false, type: BOOL, loc },
    type: BOOL,
    loc,
  };
}
