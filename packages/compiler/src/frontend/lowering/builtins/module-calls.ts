import { lowerFileUrlCall } from "./url.js";
import { lowerReadlineCreateCall } from "./readline.js";
import { lowerDiagnosticsChannelCall } from "./async-context.js";
import { lowerTimersPromisesCall } from "./timers.js";
import {
  lowerFsCallbackCall,
  lowerFsLinkOrStatfsCall,
  lowerFsTimestampCall,
  lowerFsVectorOrTruncateCall,
  lowerFsNumericOpenCall,
  lowerFsPromisesOpenCall,
  lowerFsRenameCallbackCall,
  lowerFsReadSyncCall,
  lowerFsWriteSyncCall,
  lowerFsReadDescriptorCall,
  lowerFsEncodedRead,
  lowerFsMkdirSyncCall,
  lowerFsPromisesMkdirCall,
  lowerFsRemoveCall,
  lowerFsWriteBytesCall,
  lowerFsWriteOptionsCall,
  lowerFsReadPathCall,
} from "./filesystem-calls.js";
import { lowerBufferEncodingCall } from "./text-codecs.js";
import { lowerUtilTypeCall } from "./util-types.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { type BuiltinModuleFn } from "../surfaces.js";
import { type ParamShape } from "../call-signatures.js";
import { BYTES_U8, F64, type IrExpr, STRING, type SrcLoc, VOID, arrayOf } from "../../../ir/ir.js";
import { lowerProcessLoadEnvFile } from "./environment.js";
import { lowerFsWatchCall, lowerFsReaddirTypesCall } from "./filesystem.js";
import { lowerZlibModuleCall } from "./compression.js";
import { lowerForkCall } from "./child-process.js";
import { lowerOsNetworkInterfacesCall, lowerOsUserInfoCall } from "./operating-system.js";
import { lowerQuerystringParseCall, lowerQuerystringStringifyCall } from "./querystring.js";

export function lowerBuiltinModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
): IrExpr {
  const name = expr.expression.getText();
  if (bi.module === "util/types") {
    return lowerUtilTypeCall(lowerer, expr, bi, loc, name);
  }
  if (bi.module === "process" && bi.member === "loadEnvFile")
    return lowerProcessLoadEnvFile(lowerer, expr);
  if (bi.module === "buffer" && ["isAscii", "isUtf8", "transcode"].includes(bi.member)) {
    return lowerBufferEncodingCall(lowerer, expr, bi, fn, loc);
  }
  if (fn.fn === "fs.callbackCall" && bi.member !== "rename") {
    return lowerFsCallbackCall(lowerer, expr, bi, loc);
  }
  if (
    (bi.module === "fs" &&
      ["linkSync", "symlinkSync", "readlinkSync", "statfsSync"].includes(bi.member)) ||
    (bi.module === "fs/promises" && ["link", "symlink", "readlink", "statfs"].includes(bi.member))
  ) {
    return lowerFsLinkOrStatfsCall(lowerer, expr, bi, fn, loc, name);
  }
  if (
    (bi.module === "fs" && ["utimesSync", "futimesSync", "lutimesSync"].includes(bi.member)) ||
    (bi.module === "fs/promises" && ["utimes", "lutimes"].includes(bi.member))
  ) {
    return lowerFsTimestampCall(lowerer, expr, fn, loc, name);
  }
  if (
    bi.module === "fs" &&
    (bi.member === "readvSync" || bi.member === "writevSync" || bi.member === "ftruncateSync")
  ) {
    return lowerFsVectorOrTruncateCall(lowerer, expr, bi, fn, loc, name);
  }
  if (
    bi.module === "fs" &&
    bi.member === "openSync" &&
    expr.arguments.length >= 2 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[1]!))?.kind === "f64"
  ) {
    return lowerFsNumericOpenCall(lowerer, expr, loc);
  }
  if (bi.module === "zlib") return lowerZlibModuleCall(lowerer, expr, bi, loc);
  if (bi.module === "child_process" && bi.member === "spawnSync") {
    return lowerer.lowerSpawnSyncCall(expr, loc);
  }
  if (bi.module === "child_process" && bi.member === "spawn") {
    return lowerer.lowerSpawnCall(expr, loc);
  }
  if (bi.module === "child_process" && bi.member === "fork") {
    return lowerForkCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "watch") {
    return lowerFsWatchCall(lowerer, expr, loc);
  }
  if (bi.module === "fs/promises" && bi.member === "open") {
    return lowerFsPromisesOpenCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "rename") {
    return lowerFsRenameCallbackCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "readSync") {
    return lowerFsReadSyncCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "writeSync") {
    return lowerFsWriteSyncCall(lowerer, expr, loc);
  }
  if (bi.module === "child_process" && (bi.member === "execFileSync" || bi.member === "execSync")) {
    return lowerer.lowerExecSyncCall(expr, bi.member === "execSync", loc);
  }
  if (bi.module === "os" && bi.member === "networkInterfaces") {
    return lowerOsNetworkInterfacesCall(lowerer, expr, loc);
  }
  // fs.readdirSync/fs.promises.readdir(path, { withFileTypes: true }) —
  // the Dirent forms, routed BEFORE the 1-arg table completion. The
  // options must be an object literal with withFileTypes: true (encoding
  // "utf8"/"utf-8" is accepted as the default it is; recursive and
  // encoding:'buffer' fence), and the call site's mapped type must carry
  // the interned Dirent record array (type-mapper.ts) — the userInfo
  // verification stance.
  const syncReaddirTypes = bi.module === "fs" && bi.member === "readdirSync";
  const promiseReaddirTypes = bi.module === "fs/promises" && bi.member === "readdir";
  if ((syncReaddirTypes || promiseReaddirTypes) && expr.arguments.length === 2) {
    return lowerFsReaddirTypesCall(lowerer, expr, loc, promiseReaddirTypes);
  }
  if (bi.module === "os" && bi.member === "userInfo") {
    return lowerOsUserInfoCall(lowerer, expr, loc);
  }
  // node:querystring — parse/stringify are entirely special-cased (the
  // sep/eq/options completions, parse's call-site-shaped dictionary
  // result, stringify's dyn-crossing object argument); decode/encode
  // are Node's own aliases of the pair (`const decode = parse` in the
  // module source) and take the same lowerings. escape/unescape ride
  // the generic table tail below.
  if (bi.module === "querystring") {
    if (bi.member === "parse" || bi.member === "decode") {
      return lowerQuerystringParseCall(lowerer, expr, loc);
    }
    if (bi.member === "stringify" || bi.member === "encode") {
      return lowerQuerystringStringifyCall(lowerer, expr, loc);
    }
  }
  if (bi.module === "timers/promises") {
    const lowered = lowerTimersPromisesCall(lowerer, expr, bi, loc);
    if (lowered) return lowered;
  }
  if (bi.module === "diagnostics_channel") {
    const lowered = lowerDiagnosticsChannelCall(lowerer, expr, bi, loc);
    if (lowered) return lowered;
  }
  if (bi.module === "readline" && bi.member === "createInterface") {
    return lowerReadlineCreateCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "readFileSync" && expr.arguments.length === 2) {
    const encoded = lowerFsEncodedRead(
      lowerer,
      expr,
      lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[0]!))?.kind === "f64",
      loc,
    );
    if (encoded) return encoded;
  }
  // The Buffer forms of fs: readFileSync(path)/readFile(path) with NO
  // encoding read raw bytes (Node returns a Buffer there), and
  // writeFileSync(path, data) with bytes-typed data writes them —
  // routed BEFORE the arity/type completion against the utf8 table
  // entries.
  if (
    bi.module === "fs" &&
    bi.member === "readFileSync" &&
    expr.arguments.length === 1 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[0]!))?.kind !== "f64"
  ) {
    const path = lowerer.lowerExprExpecting(expr.arguments[0]!, STRING);
    return { kind: "libCall", fn: "fs.readFileSyncBytes", args: [path], type: BYTES_U8, loc };
  }
  if (bi.module === "fs/promises" && bi.member === "readFile" && expr.arguments.length === 1) {
    const path = lowerer.lowerExprExpecting(expr.arguments[0]!, STRING);
    return {
      kind: "libCall",
      fn: "fsp.readFileBytes",
      args: [path],
      type: { kind: "promise", inner: BYTES_U8 },
      loc,
    };
  }
  if (
    bi.module === "fs" &&
    bi.member === "readFileSync" &&
    expr.arguments.length >= 1 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments[0]!))?.kind === "f64"
  ) {
    return lowerFsReadDescriptorCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "mkdirSync" && expr.arguments.length === 2) {
    return lowerFsMkdirSyncCall(lowerer, expr, loc);
  }
  if (bi.module === "fs/promises" && bi.member === "mkdir" && expr.arguments.length === 2) {
    return lowerFsPromisesMkdirCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "rmSync" && expr.arguments.length === 2) {
    return lowerFsRemoveCall(lowerer, expr, loc);
  }
  // accessSync(p, mode?): an omitted mode is Node's F_OK (0). The mode
  // is an ordinary number — fs.constants.* reads bake to literals.
  if (bi.module === "fs" && bi.member === "accessSync") {
    if (expr.arguments.length < 1 || expr.arguments.length > 2) {
      lowerer.noLowering(`accessSync with ${expr.arguments.length} arguments`, expr);
    }
    const path = lowerer.lowerExprExpecting(expr.arguments[0]!, STRING);
    const mode: IrExpr = expr.arguments[1]
      ? lowerer.lowerExprExpecting(expr.arguments[1], F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    return { kind: "libCall", fn: "fs.accessSync", args: [path, mode], type: VOID, loc };
  }
  if (
    bi.module === "fs" &&
    (bi.member === "writeFileSync" || bi.member === "appendFileSync") &&
    expr.arguments.length === 2
  ) {
    const lowered = lowerFsWriteBytesCall(lowerer, expr, bi, loc);
    if (lowered) return lowered;
  }
  // writeFileSync(p, data, options) / fs.promises.writeFile(p, data,
  // options): the lowered options are a literal
  // `{ mode?: <number>, encoding?: "utf8" }` — the mode is open(2)'s
  // O_CREAT argument (creation only; an existing file keeps its
  // permissions, exactly Node), and the encoding may only spell the
  // utf8 the runtime writes anyway. String data only — Buffer options
  // remain outside the static surface.
  const syncWriteOptions = bi.module === "fs" && bi.member === "writeFileSync";
  const promiseWriteOptions = bi.module === "fs/promises" && bi.member === "writeFile";
  if ((syncWriteOptions || promiseWriteOptions) && expr.arguments.length === 3) {
    return lowerFsWriteOptionsCall(lowerer, expr, loc, promiseWriteOptions);
  }
  if (fn.variadicPack) {
    // join(...parts) forwards the array itself; mixing spread and plain
    // arguments (or spreading anything but a string[]) stays out.
    const spread = expr.arguments.find(ts.isSpreadElement);
    if (spread) {
      if (expr.arguments.length === 1) {
        // The whole-array form forwards the operand directly (no copy).
        const packed = lowerer.lowerExprExpecting(spread.expression, arrayOf(STRING));
        return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
      }
      // The MIXED form — resolve(tmpPath, ...paths), test/common's
      // tmpdir.resolve: plain arguments and spread arrays pack into one
      // fresh string[] (arrayLit's spread positions copy element-wise,
      // JS-exact; a dyn spread source rides the validated extraction).
      const elems = expr.arguments.map((a) =>
        ts.isSpreadElement(a)
          ? lowerer.lowerExprExpecting(a.expression, arrayOf(STRING))
          : lowerer.lowerExprExpecting(a, STRING),
      );
      const spreads = expr.arguments.flatMap((a, i) => (ts.isSpreadElement(a) ? [i] : []));
      const packed: IrExpr = { kind: "arrayLit", elems, spreads, type: arrayOf(STRING), loc };
      return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
    }
    const elems = expr.arguments.map((a) => lowerer.lowerExprExpecting(a, STRING));
    const packed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(STRING), loc };
    return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
  }
  if (
    bi.module === "fs" &&
    bi.member === "readFileSync" &&
    expr.arguments.length >= 1 &&
    expr.arguments.length <= 2 &&
    !expr.arguments.some(ts.isSpreadElement)
  ) {
    const lowered = lowerFsReadPathCall(lowerer, expr, loc);
    if (lowered) return lowered;
  }
  const required = fn.params.length - (fn.defaults?.length ?? 0);
  const hasSpread = expr.arguments.some(ts.isSpreadElement);
  if (
    bi.module === "url" &&
    ["fileURLToPath", "fileURLToPathBuffer", "pathToFileURL"].includes(bi.member)
  ) {
    return lowerFileUrlCall(lowerer, expr, bi, fn, loc, hasSpread);
  }
  if (
    hasSpread &&
    ((bi.module === "fs" && bi.member === "readFileSync") ||
      (bi.module === "fs/promises" && bi.member === "readFile"))
  ) {
    lowerer.noLowering(
      `${bi.member} with spread arguments`,
      expr,
      `call ${bi.member}(path, "utf8") directly so the required literal encoding remains statically visible`,
    );
  }
  if (
    !hasSpread &&
    (expr.arguments.length < required || expr.arguments.length > fn.params.length)
  ) {
    lowerer.noLowering(
      `${name} with ${expr.arguments.length} argument${expr.arguments.length === 1 ? "" : "s"}`,
      expr,
      bi.member === "readFileSync" || bi.member === "readFile"
        ? `pass the encoding: ${bi.member}(path, "utf8") — Buffer reads and options objects have no lowering`
        : `the supported form takes ${fn.params.length} argument${fn.params.length === 1 ? "" : "s"} (no options objects)`,
    );
  }
  if (
    !hasSpread &&
    ((bi.module === "fs" && bi.member === "readFileSync") ||
      (bi.module === "fs/promises" && bi.member === "readFile"))
  ) {
    // The runtime reads utf8 unconditionally; any other encoding would
    // silently decode wrong, so the ARGUMENT'S TYPE must be the literal
    // "utf8" — or Node's "utf-8" alias, the same decoder (the fallback
    // declaration enforces the pair at typecheck; @types/node accepts
    // every BufferEncoding).
    const enc = lowerer.typeOf(expr.arguments[1]!);
    if (!(enc.isStringLiteralType() && (enc.value === "utf8" || enc.value === "utf-8"))) {
      lowerer.noLowering(
        `${bi.member} with a non-"utf8" encoding`,
        expr.arguments[1]!,
        `only utf8 reads are supported: ${bi.member}(path, "utf8")`,
      );
    }
  }
  // A value-enabled builtin with defaults uses its generated adapter for
  // direct calls too. That keeps explicit undefined identical to omission:
  // completeArgs wraps the undefined arm, then the adapter selects the
  // descriptor's default before entering the fixed runtime libCall ABI.
  // The call has already passed this member's ordinary arity/shape gates.
  if (fn.defaults && fn.valueParams) {
    const callee = lowerer.lowerBuiltinCallableValue(bi, loc);
    if (!callee || callee.type.kind !== "func") {
      throw new InternalCompilerError(`missing callable adapter for ${bi.module}.${bi.member}`);
    }
    const funcType = callee.type;
    const shapes: ParamShape[] = fn.valueParams.map((param, index) => {
      const type = funcType.params[index];
      if (!type)
        throw new InternalCompilerError(
          `missing callable parameter ${index} for ${bi.module}.${bi.member}`,
        );
      return { type, mode: param.mode === "optional" ? "omittable" : "required" };
    });
    const args = lowerer.completeArgs(expr.arguments, shapes, loc, expr);
    return { kind: "callValue", callee, args, type: callee.type.ret, loc };
  }
  let args: IrExpr[];
  if (hasSpread) {
    const shapes = fn.params.map((type, i): ParamShape =>
      i < required
        ? { type, mode: "required" }
        : {
            type,
            mode: "omittable",
            callDefault: {
              kind: "strLit",
              value: fn.defaults![i - required]!,
              type: STRING,
              loc,
            },
          },
    );
    args = lowerer.completeArgs(expr.arguments, shapes, loc, expr);
  } else {
    args = expr.arguments.map((a, i) => lowerer.lowerExprExpecting(a, fn.params[i]));
    for (let i = args.length; i < fn.params.length; i++) {
      const dflt = fn.defaults![i - required]!;
      args.push({ kind: "strLit", value: dflt, type: STRING, loc });
    }
  }
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}
