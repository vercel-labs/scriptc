import { lowerFileUrlCall, lowerLegacyUrlCall } from "./url.js";
import { lowerReadlineCreateCall } from "./readline.js";
import { lowerDiagnosticsChannelCall } from "./async-context.js";
import { lowerTimersPromisesCall } from "./timers.js";
import {
  lowerFsCallbackCall,
  lowerFsCpCall,
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
  lowerFsPromisesEncodedRead,
  lowerFsMkdirSyncCall,
  lowerFsOpendirCall,
  lowerFsStreamCreate,
  lowerFsPromisesMkdirCall,
  lowerFsRemoveCall,
  lowerFsWriteBytesCall,
  lowerFsWriteOptionsCall,
  lowerFsReadPathCall,
} from "./filesystem-calls.js";
import { checkFsUrlPaths, isFsPathParam, lowerFallibleFsUrlCall, lowerFsPath } from "./fs-paths.js";
import { lowerBufferEncodingCall } from "./text-codecs.js";
import { lowerUtilTypeCall } from "./util-types.js";
import { InternalCompilerError } from "../../../errors.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { type BuiltinModuleFn } from "../surfaces.js";
import { type ParamShape } from "../call-signatures.js";
import { BYTES_U8, DYN, F64, type IrExpr, STRING, type SrcLoc, arrayOf } from "../../../ir/ir.js";
import { typeKey } from "../../type-mapper.js";
import { lowerProcessLoadEnvFile } from "./environment.js";
import { lowerFsWatchCall, lowerFsReaddirTypesCall, lowerFsStatOptionsCall } from "./filesystem.js";
import { lowerZlibModuleCall } from "./compression.js";
import { lowerForkCall } from "./child-process.js";
import {
  lowerOsCpusCall,
  lowerOsGetPriorityCall,
  lowerOsSetPriorityCall,
  lowerOsNetworkInterfacesCall,
  lowerOsUserInfoCall,
  lowerPathFormatCall,
  lowerPathParseCall,
} from "./operating-system.js";
import { lowerQuerystringParseCall, lowerQuerystringStringifyCall } from "./querystring.js";
import { lowerFsGlobCallbackCall, lowerFsGlobSyncCall, lowerFspGlobCall } from "./fs-glob.js";
import { lowerV8HeapStatisticsCall } from "./v8.js";

export function lowerBuiltinModuleCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
  loc: SrcLoc,
): IrExpr {
  const name = ts.getTextOfNode(expr.expression);
  const fallible = lowerFallibleFsUrlCall(lowerer, expr, bi, () =>
    lowerBuiltinModuleCall(lowerer, expr, bi, fn, loc),
  );
  if (fallible) return fallible;
  checkFsUrlPaths(lowerer, expr, bi);
  if (bi.module === "util/types") {
    return lowerUtilTypeCall(lowerer, expr, bi, loc, name);
  }
  if (bi.module === "process" && bi.member === "loadEnvFile")
    return lowerProcessLoadEnvFile(lowerer, expr);
  if (bi.module === "buffer" && ["isAscii", "isUtf8", "transcode"].includes(bi.member)) {
    return lowerBufferEncodingCall(lowerer, expr, bi, fn, loc);
  }
  if (bi.module === "fs" && bi.member === "glob")
    return lowerFsGlobCallbackCall(lowerer, expr, loc);
  if (bi.module === "fs" && bi.member === "globSync")
    return lowerFsGlobSyncCall(lowerer, expr, loc);
  if (bi.module === "fs/promises" && bi.member === "glob")
    return lowerFspGlobCall(lowerer, expr, loc);
  if (fn.fn === "fs.callbackCall" && bi.member !== "rename") {
    return lowerFsCallbackCall(lowerer, expr, bi, loc);
  }
  if (
    (bi.module === "fs" && bi.member === "cpSync") ||
    (bi.module === "fs/promises" && bi.member === "cp")
  )
    return lowerFsCpCall(lowerer, expr, fn, loc, name);
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
    expr.arguments.nodes.length >= 2 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!))?.kind === "f64"
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
  if (bi.module === "v8" && bi.member === "getHeapStatistics") {
    return lowerV8HeapStatisticsCall(lowerer, expr, loc);
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
  if ((syncReaddirTypes || promiseReaddirTypes) && expr.arguments.nodes.length === 2) {
    return lowerFsReaddirTypesCall(lowerer, expr, loc, promiseReaddirTypes);
  }
  // fs.statSync/fs.lstatSync(path, options): throwIfNoEntry and bigint:
  // false, routed BEFORE the 1-arg table completion.
  if (
    bi.module === "fs" &&
    (bi.member === "statSync" || bi.member === "lstatSync") &&
    expr.arguments.nodes.length === 2
  ) {
    return lowerFsStatOptionsCall(lowerer, expr, loc, bi.member === "lstatSync");
  }
  if (bi.module === "os" && bi.member === "userInfo") {
    return lowerOsUserInfoCall(lowerer, expr, loc);
  }
  if (bi.module === "os" && bi.member === "cpus") {
    return lowerOsCpusCall(lowerer, expr, loc);
  }
  if (bi.module === "os" && bi.member === "setPriority") {
    return lowerOsSetPriorityCall(lowerer, expr, loc);
  }
  if (bi.module === "os" && bi.member === "getPriority") {
    return lowerOsGetPriorityCall(lowerer, expr, loc);
  }
  // path.parse/path.format: the bare module is the TARGET platform's
  // family, the namespaces their own.
  if (
    (bi.module === "path" || bi.module === "path/posix" || bi.module === "path/win32") &&
    (bi.member === "parse" || bi.member === "format")
  ) {
    const win32 =
      bi.module === "path/win32" || (bi.module === "path" && lowerer.targetPlatform === "win32");
    return bi.member === "parse"
      ? lowerPathParseCall(lowerer, expr, win32, loc)
      : lowerPathFormatCall(lowerer, expr, win32, loc);
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
  if (
    bi.module === "url" &&
    ["parse", "format", "resolve", "domainToASCII", "domainToUnicode"].includes(bi.member)
  ) {
    return lowerLegacyUrlCall(lowerer, expr, bi, fn, loc);
  }
  if (bi.module === "timers/promises") {
    const lowered = lowerTimersPromisesCall(lowerer, expr, bi, loc);
    if (lowered) return lowered;
  }
  if (bi.module === "diagnostics_channel") {
    const lowered = lowerDiagnosticsChannelCall(lowerer, expr, bi, loc);
    if (lowered) return lowered;
  }
  if (
    (bi.module === "readline" || bi.module === "readline/promises") &&
    bi.member === "createInterface"
  ) {
    return lowerReadlineCreateCall(lowerer, expr, loc, bi.module === "readline/promises");
  }
  if (bi.module === "fs" && bi.member === "readFileSync" && expr.arguments.nodes.length === 2) {
    const encoded = lowerFsEncodedRead(
      lowerer,
      expr,
      lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[0]!))?.kind === "f64",
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
    expr.arguments.nodes.length === 1 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[0]!))?.kind !== "f64"
  ) {
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
    return { kind: "libCall", fn: "fs.readFileSyncBytes", args: [path], type: BYTES_U8, loc };
  }
  if (
    bi.module === "fs/promises" &&
    bi.member === "readFile" &&
    expr.arguments.nodes.length === 2
  ) {
    const encoded = lowerFsPromisesEncodedRead(lowerer, expr, loc);
    if (encoded) return encoded;
  }
  if (
    bi.module === "fs/promises" &&
    bi.member === "readFile" &&
    expr.arguments.nodes.length === 1
  ) {
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
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
    expr.arguments.nodes.length >= 1 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[0]!))?.kind === "f64"
  ) {
    return lowerFsReadDescriptorCall(lowerer, expr, loc);
  }
  if (
    (bi.module === "fs" && bi.member === "opendirSync") ||
    (bi.module === "fs/promises" && bi.member === "opendir")
  ) {
    return lowerFsOpendirCall(lowerer, expr, fn, bi.member, loc);
  }
  if (
    bi.module === "fs" &&
    (bi.member === "createReadStream" || bi.member === "createWriteStream")
  ) {
    return lowerFsStreamCreate(lowerer, expr, bi.member, loc);
  }
  if (bi.module === "fs" && bi.member === "mkdirSync" && expr.arguments.nodes.length === 2) {
    return lowerFsMkdirSyncCall(lowerer, expr, loc);
  }
  if (bi.module === "fs/promises" && bi.member === "mkdir" && expr.arguments.nodes.length === 2) {
    return lowerFsPromisesMkdirCall(lowerer, expr, loc);
  }
  if (bi.module === "fs" && bi.member === "rmSync" && expr.arguments.nodes.length === 2) {
    return lowerFsRemoveCall(lowerer, expr, loc, false);
  }
  if (bi.module === "fs/promises" && bi.member === "rm" && expr.arguments.nodes.length === 2) {
    return lowerFsRemoveCall(lowerer, expr, loc, true);
  }
  // accessSync(p, mode?) and truncateSync(p, len?), with their promise
  // spellings: an omitted mode is Node's F_OK (0) and an omitted len is 0.
  // The mode is an ordinary number — fs.constants.* reads bake to literals.
  const zeroDefault =
    bi.module === "fs"
      ? bi.member === "accessSync" || bi.member === "truncateSync"
      : bi.module === "fs/promises" && (bi.member === "access" || bi.member === "truncate");
  if (zeroDefault) {
    if (expr.arguments.nodes.length < 1 || expr.arguments.nodes.length > 2) {
      lowerer.noLowering(`${bi.member} with ${expr.arguments.nodes.length} arguments`, expr);
    }
    const path = lowerFsPath(lowerer, expr.arguments.nodes[0]!);
    const second: IrExpr = expr.arguments.nodes[1]
      ? lowerer.lowerExprExpecting(expr.arguments.nodes[1], F64)
      : { kind: "numLit", value: 0, type: F64, loc };
    return { kind: "libCall", fn: fn.fn, args: [path, second], type: fn.result, loc };
  }
  if (
    bi.module === "fs/promises" &&
    bi.member === "appendFile" &&
    expr.arguments.nodes.length === 2 &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.arguments.nodes[1]!))?.kind === "bytes"
  ) {
    const lowered = lowerFsWriteBytesCall(lowerer, expr, bi, loc);
    if (lowered) return lowered;
  }
  if (
    bi.module === "fs" &&
    (bi.member === "writeFileSync" || bi.member === "appendFileSync") &&
    expr.arguments.nodes.length === 2
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
  if ((syncWriteOptions || promiseWriteOptions) && expr.arguments.nodes.length === 3) {
    return lowerFsWriteOptionsCall(lowerer, expr, loc, promiseWriteOptions);
  }
  if (fn.variadicPack) {
    // join(...parts) forwards the array itself; mixing spread and plain
    // arguments (or spreading anything but a string[]) stays out.
    const spread = expr.arguments.nodes.find(ts.isSpreadElement);
    if (spread) {
      if (expr.arguments.nodes.length === 1) {
        // The whole-array form forwards the operand directly (no copy).
        const packed = lowerer.lowerExprExpecting(spread.expression, arrayOf(STRING));
        return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
      }
      // The MIXED form — resolve(tmpPath, ...paths), test/common's
      // tmpdir.resolve: plain arguments and spread arrays pack into one
      // fresh string[] (arrayLit's spread positions copy element-wise,
      // JS-exact; a dyn spread source rides the validated extraction).
      const elems = expr.arguments.nodes.map((a) =>
        ts.isSpreadElement(a)
          ? lowerer.lowerExprExpecting(a.expression, arrayOf(STRING))
          : lowerer.lowerExprExpecting(a, STRING),
      );
      const spreads = expr.arguments.nodes.flatMap((a, i) => (ts.isSpreadElement(a) ? [i] : []));
      const packed: IrExpr = { kind: "arrayLit", elems, spreads, type: arrayOf(STRING), loc };
      return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
    }
    const elems = expr.arguments.nodes.map((a) => lowerer.lowerExprExpecting(a, STRING));
    const packed: IrExpr = { kind: "arrayLit", elems, type: arrayOf(STRING), loc };
    return { kind: "libCall", fn: fn.fn, args: [packed], type: fn.result, loc };
  }
  if (
    bi.module === "fs" &&
    bi.member === "readFileSync" &&
    expr.arguments.nodes.length >= 1 &&
    expr.arguments.nodes.length <= 2 &&
    !expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const lowered = lowerFsReadPathCall(lowerer, expr, loc);
    if (lowered) return lowered;
  }
  // util._extend over a typed target: the writes go through its
  // checked-dynamic view, and the call answers the target itself, as Node
  // does, when the result type is the target's.
  if (
    bi.module === "util" &&
    bi.member === "_extend" &&
    expr.arguments.nodes.length >= 1 &&
    !expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const target = lowerer.lowerExpr(expr.arguments.nodes[0]!);
    const resultType = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (
      target.type.kind !== "dyn" &&
      resultType !== null &&
      typeKey(resultType) === typeKey(target.type)
    ) {
      const held = lowerer.declareHiddenLocal("%extendTarget", target.type);
      const ref = varRef(held.id, target.type, loc);
      const source = expr.arguments.nodes[1]
        ? lowerer.lowerExprExpecting(expr.arguments.nodes[1], DYN)
        : dynUndefinedExpr(loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: held.id, init: target, loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "util.extend",
              args: [lowerer.coerceToExpected(ref, DYN), source],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        result: ref,
        type: target.type,
        loc,
      };
    }
  }
  // Trailing checked-dynamic parameters whose value adapter defaults to
  // undefined may be omitted: the call passes undefined, as Node sees it.
  let undefinedTail = 0;
  if (!fn.defaults && fn.valueParams) {
    for (let i = fn.valueParams.length - 1; i >= 0; i--) {
      const param = fn.valueParams[i]!;
      if (
        param.mode !== "optional" ||
        param.defaultValue !== undefined ||
        fn.params[i]?.kind !== "dyn"
      )
        break;
      undefinedTail++;
    }
  }
  const required = fn.params.length - (fn.defaults?.length ?? undefinedTail);
  const hasSpread = expr.arguments.nodes.some(ts.isSpreadElement);
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
    (expr.arguments.nodes.length < required || expr.arguments.nodes.length > fn.params.length)
  ) {
    lowerer.noLowering(
      `${name} with ${expr.arguments.nodes.length} argument${expr.arguments.nodes.length === 1 ? "" : "s"}`,
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
    // decode wrong without an error, so the ARGUMENT'S TYPE must be the literal
    // "utf8" — or Node's "utf-8" alias, the same decoder (the fallback
    // declaration enforces the pair at typecheck; @types/node accepts
    // every BufferEncoding).
    const enc = lowerer.typeOf(expr.arguments.nodes[1]!);
    if (!(enc.isStringLiteralType() && (enc.value === "utf8" || enc.value === "utf-8"))) {
      lowerer.noLowering(
        `${bi.member} with a non-"utf8" encoding`,
        expr.arguments.nodes[1]!,
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
    const args = lowerer.completeArgs(expr.arguments.nodes, shapes, loc, expr);
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
            callDefault: fn.defaults
              ? { kind: "strLit", value: fn.defaults[i - required]!, type: STRING, loc }
              : dynUndefinedExpr(loc),
          },
    );
    args = lowerer.completeArgs(expr.arguments.nodes, shapes, loc, expr);
  } else {
    args = expr.arguments.nodes.map((a, i) =>
      isFsPathParam(bi.module, bi.member, i)
        ? lowerFsPath(lowerer, a)
        : lowerer.lowerExprExpecting(a, fn.params[i]),
    );
    for (let i = args.length; i < fn.params.length; i++) {
      if (!fn.defaults) {
        args.push(dynUndefinedExpr(loc));
        continue;
      }
      const dflt = fn.defaults[i - required]!;
      args.push({ kind: "strLit", value: dflt, type: STRING, loc });
    }
  }
  return { kind: "libCall", fn: fn.fn, args, type: fn.result, loc };
}
