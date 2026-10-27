import { keyedHelperName } from "../stable-names.js";
import { dynUndefinedExpr, boolLit, numLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer, ladderFenceExpr } from "../lowerer.js";
import { lowerFsPath } from "./fs-paths.js";
import { isJsSourceFile, locOf } from "../../program.js";
import {
  builtinModuleFnOf,
  FS_READDIR_DOCUMENTED_OPTIONS,
  FS_WATCH_DOCUMENTED_OPTIONS,
  fenceOrDropOptionKey,
} from "../surfaces.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";
import {
  BOOL,
  BYTES_U8,
  DIR_T,
  DYN,
  F64,
  FILEHANDLE_T,
  FSWATCHER_T,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  STATS_T,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  isUnitType,
  typeEquals,
} from "../../../ir/ir.js";
import { optionMember, lowerBuiltinOptionalDefault } from "./arguments.js";
import { isSafeToDiscard } from "../expressions/evaluation-safety.js";

type FsSyncBufferWindowSource =
  | { kind: "options"; node: ts.Expression | undefined }
  | { kind: "offset"; node: ts.Expression };

/** Normalize fs.readSync/fs.writeSync's shorthand and inline-options buffer
 * forms into the existing fixed-width descriptor IR. fd and buffer bind
 * first, option values bind in object-literal order, and only then do the
 * default window expressions read the bound buffer length. */
export function lowerFsSyncBufferWindow(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  fn: "fs.readSync" | "fs.writeSync",
  source: FsSyncBufferWindowSource,
  supported: string,
): IrExpr {
  const fdValue = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, F64);
  const bufferValue = lowerer.lowerExprExpecting(expr.arguments.nodes[1]!, BYTES_U8);
  const fdLocal = lowerer.declareHiddenLocal("%fsSyncFd", F64);
  const bufferLocal = lowerer.declareHiddenLocal("%fsSyncBuffer", BYTES_U8);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: fdLocal.id, init: fdValue, loc: fdValue.loc },
    { kind: "varDecl", localId: bufferLocal.id, init: bufferValue, loc: bufferValue.loc },
  ];
  const fd = (): IrExpr => varRef(fdLocal.id, fdLocal.type, loc);
  const buffer = (): IrExpr => varRef(bufferLocal.id, bufferLocal.type, loc);
  const number = (value: number): IrExpr => numLit(value, loc);
  const stageNumber = (name: string, node: ts.Expression): IrExpr => {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (mapped?.kind !== "f64") {
      lowerer.noLowering(
        `${fn} with a '${mapped ? lowerer.fmt(mapped) : lowerer.checker.typeToString(lowerer.typeOf(node))}' ${name}`,
        node,
        supported,
      );
    }
    const value = lowerer.lowerExprExpecting(node, F64);
    const local = lowerer.declareHiddenLocal(`%fsSync${name}`, F64);
    stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
    return varRef(local.id, local.type, loc);
  };
  const isNull = (node: ts.Expression): boolean => {
    let value = node;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    return value.kind === ts.SyntaxKind.NullKeyword;
  };

  let offset: IrExpr | null = null;
  let length: IrExpr | null = null;
  let position: IrExpr | null = null;
  if (source.kind === "offset") {
    offset = stageNumber("offset", source.node);
  } else if (source.node !== undefined && !isNull(source.node)) {
    if (!ts.isObjectLiteralExpression(source.node)) {
      lowerer.noLowering(`${fn} with a non-literal options argument`, source.node, supported);
    }
    for (const property of (source.node as ts.ObjectLiteralExpression).properties.nodes) {
      const member = optionMember(property);
      if (member === null) {
        lowerer.noLowering(`${fn} with a non-plain options member`, property, supported);
      }
      if (member.name === "offset") {
        offset = stageNumber("offset", member.value);
      } else if (member.name === "length") {
        length = stageNumber("length", member.value);
      } else if (member.name === "position") {
        position = isNull(member.value) ? null : stageNumber("position", member.value);
      } else {
        const effect = lowerer.lowerExpr(member.value);
        stmts.push({ kind: "exprStmt", expr: effect, loc: effect.loc });
      }
    }
  }

  const normalizedOffset = offset ?? number(0);
  const normalizedLength =
    length ??
    ({
      kind: "bin",
      op: "-",
      left: {
        kind: "bytesIntrinsic",
        method: "length",
        receiver: buffer(),
        args: [],
        type: F64,
        loc,
      },
      right: normalizedOffset,
      type: F64,
      loc,
    } satisfies IrExpr);
  const result: IrExpr = {
    kind: "libCall",
    fn,
    args: [fd(), buffer(), normalizedOffset, normalizedLength, position ?? number(-1)],
    type: F64,
    loc,
  };
  return { kind: "seqExpr", stmts, result, type: F64, loc };
}

/** One builtin-module function call → its libCall. Completes the call to
 * the table's exact shape: variadicPack functions (path.join/resolve)
 * accept any arity — or ONE spread of a string[] — and pack the
 * arguments into a single array-literal argument; `defaults` complete
 * omitted trailing arguments. fs.readFileSync keeps its historical
 * per-site checks (the encoding must be the literal "utf8"). */
/** fs._toUnixTimestamp — the (underscore-stable) seconds coercion the
 * utimes family runs on its time arguments: finite numbers pass
 * (negatives answer now/1000, Node's shape), numeric STRINGS coerce
 * through ToNumber's loose-equality gate, everything else throws
 * Node's exact ERR_INVALID_ARG_TYPE. The argument crosses as a dyn
 * value so the runtime renders the Received tail. Null when this is
 * not that call (the table fence stays for other shapes). */
export function lowerFsTimestampValue(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  if (!node) return dynUndefinedExpr(loc);
  const box = (value: IrExpr): IrExpr => {
    if (value.type.kind === "date") {
      const milliseconds: IrExpr = {
        kind: "libCall",
        fn: "date.getTime",
        args: [value],
        type: F64,
        loc,
      };
      return {
        kind: "libCall",
        fn: "date.nativeNew",
        args: [
          {
            kind: "dynArrLit",
            elems: [{ kind: "dynFrom", value: milliseconds, type: DYN, loc }],
            type: DYN,
            loc,
          },
        ],
        type: DYN,
        loc,
      };
    }
    return lowerer.coerceInto(node, value, DYN);
  };
  return box(lowerer.lowerExpr(node));
}

export function lowerFsToUnixTimestampCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "fs" || bi.member !== "_toUnixTimestamp") return null;
  if (expr.arguments.nodes.length !== 1 || ts.isSpreadElement(expr.arguments.nodes[0]!))
    return null;
  return {
    kind: "libCall",
    fn: "fs.toUnixTimestamp",
    args: [lowerFsTimestampValue(lowerer, expr.arguments.nodes[0], loc)],
    type: F64,
    loc,
  };
}

/** True when opendirSync's arguments fit lowerFsOpendirCall: a string
 * path and no options, or an object literal whose members are a numeric
 * bufferSize and a utf8 encoding. */
function opendirLowers(lowerer: Lowerer, args: readonly ts.Expression[]): boolean {
  if (args.length < 1 || args.length > 2) return false;
  if (lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind !== "string") return false;
  const options = args[1];
  if (!options || (ts.isIdentifier(options) && options.text === "undefined")) return true;
  if (!ts.isObjectLiteralExpression(options)) return false;
  return options.properties.nodes.every((property) => {
    const option = optionMember(property);
    if (!option) return false;
    if (option.name === "bufferSize")
      return lowerer.mapTypeOf(lowerer.typeOf(option.value))?.kind === "f64";
    if (option.name !== "encoding") return false;
    const encoding = lowerer.typeOf(option.value);
    return (
      encoding.isStringLiteralType() && (encoding.value === "utf8" || encoding.value === "utf-8")
    );
  });
}

/** The fs validation-ladder spoke (checked-dynamic lane, JS sources
 * only — TypeScript keeps its compile fences): implemented-namespace
 * calls whose misuse Node rejects with typed errors lower to fs.*Chk
 * libCalls that replicate the validation ladder over dyn values and
 * throw Node's exact ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE /
 * ERR_OUT_OF_RANGE — the honest tail (the real operation where one
 * exists, the compiler-rendered SC2020 fence otherwise) runs only
 * after every validation passes, exactly Node's order. Null when this
 * is not a claimed member/shape (the table or fence path stands). */
export function lowerFsLadderCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (
    bi.module === "fs" &&
    bi.member !== "rename" &&
    builtinModuleFnOf(lowerer, bi.module, bi.member)?.fn === "fs.callbackCall"
  ) {
    return lowerer.lowerBuiltinModuleCall(
      expr,
      bi,
      { fn: "fs.callbackCall", params: [], result: DYN },
      loc,
    );
  }
  if (bi.module !== "fs" && bi.module !== "fs/promises") return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) return null;
  // Every ladder argument crosses as a dyn value; an argument that
  // cannot leaves the historical fence in place.
  const dynArg = (node: ts.Expression | undefined): IrExpr | null => {
    if (!node) return dynUndefinedExpr(loc);
    const raw = lowerer.lowerExpr(node);
    if (raw.type.kind === "dyn") return raw;
    if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      return { kind: "dynFrom", value: raw, type: DYN, loc };
    }
    return null;
  };
  const dynArgs = (nodes: (ts.Expression | undefined)[]): IrExpr[] | null => {
    const out: IrExpr[] = [];
    for (const n of nodes) {
      const v = dynArg(n);
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  const resultT = lowerer.mapTypeOf(lowerer.typeOf(expr)) ?? DYN;
  const chk = (fn: IrLibFn, chkArgs: IrExpr[], type: IrType): IrExpr => ({
    kind: "libCall",
    fn,
    args: chkArgs,
    type,
    loc,
  });
  if (bi.module === "fs/promises") {
    if (bi.member !== "lchmod" || args.length !== 2) return null;
    const a = dynArgs([args[0], args[1]]);
    return a && chk("fsp.lchmodChk", a, { kind: "promise", inner: VOID });
  }
  switch (bi.member) {
    case "exists": {
      // The REAL deprecated-API shape: the callback validates
      // synchronously (Node's one throwing arm), invalid paths answer
      // false THROUGH it, and the answer is asynchronous.
      // A provably-non-file `new URL('<literal>')` path (the suite's
      // https://foo probe): Node answers false through the callback
      // synchronously — the checked-dynamic tree has no URL kind, so the path slot
      // carries the unvalidatable token instead (construction of a
      // parseable literal is effect-free; file: URLs keep the fence —
      // they would need the real path conversion).
      let pathNode: ts.Expression | undefined = args[0];
      let pathExpr: IrExpr | null = null;
      if (
        pathNode &&
        ts.isNewExpression(pathNode) &&
        ts.isIdentifier(pathNode.expression) &&
        pathNode.expression.text === "URL" &&
        lowerer.mapTypeOf(lowerer.typeOf(pathNode))?.kind === "url" &&
        pathNode.arguments?.nodes.length === 1 &&
        ts.isStringLiteral(pathNode.arguments.nodes[0]!)
      ) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(pathNode.arguments.nodes[0]!.text);
        } catch {
          parsed = null;
        }
        if (parsed === null || parsed.protocol === "file:") return null;
        pathExpr = dynUndefinedExpr(loc);
        pathNode = undefined;
      }
      pathExpr ??= dynArg(pathNode);
      const cbExpr = dynArg(args[1]);
      if (pathExpr === null || cbExpr === null) return null;
      return chk("fs.existsChk", [pathExpr, cbExpr], DYN);
    }
    case "mkdtemp": {
      // mkdtemp(prefix[, options], callback) — the callback is the
      // LAST argument (makeCallback runs first, then the prefix).
      const a = dynArgs([args[0], args.length >= 2 ? args[args.length - 1] : undefined]);
      return (
        a && chk("fs.mkdtempChk", [...a, ladderFenceExpr(lowerer, "fs.mkdtemp", expr)], resultT)
      );
    }
    case "mkdtempSync": {
      // The table serves the plain string 1-arg form; the ladder takes
      // every other shape — prefix/encoding validation, then the REAL
      // mkdtemp when the options leave utf8 semantics.
      if (args.length === 1 && lowerer.mapTypeOf(lowerer.typeOf(args[0]!))?.kind === "string")
        return null;
      if (args.length > 2) return null;
      const a = dynArgs([args[0], args[1]]);
      return (
        a &&
        chk(
          "fs.mkdtempSyncChk",
          [...a, ladderFenceExpr(lowerer, "fs.mkdtempSync with these options", expr)],
          STRING,
        )
      );
    }
    case "readFile": {
      // readFile(path[, options], callback): callback, assertEncoding,
      // path — then the async read fences.
      const a = dynArgs([
        args[0],
        args.length >= 3 ? args[1] : undefined,
        args.length >= 2 ? args[args.length - 1] : undefined,
      ]);
      return (
        a && chk("fs.readFileChk", [...a, ladderFenceExpr(lowerer, "fs.readFile", expr)], resultT)
      );
    }
    case "opendirSync": {
      // A string path with no options or a literal { bufferSize, encoding:
      // "utf8" } takes the real lowering; anything else keeps Node's
      // validation ladder and its fence.
      if (opendirLowers(lowerer, args)) return null;
      const a = dynArgs([args[0], args[1]]);
      return (
        a && chk("fs.opendirChk", [...a, ladderFenceExpr(lowerer, "fs.opendirSync", expr)], resultT)
      );
    }
    case "watchFile": {
      // watchFile(filename[, options], listener): the path first, the
      // listener's function contract second; real watching fences.
      const a = dynArgs([args[0], args.length >= 2 ? args[args.length - 1] : undefined]);
      return (
        a && chk("fs.watchFileChk", [...a, ladderFenceExpr(lowerer, "fs.watchFile", expr)], resultT)
      );
    }
    case "lchmod": {
      // lchmod(path, mode, callback): callback, path, mode — macOS
      // shapes (non-APPLE answers Node's not-a-function TypeError).
      const a = dynArgs([args[0], args[1], args[2]]);
      return a && chk("fs.lchmodChk", [...a, ladderFenceExpr(lowerer, "fs.lchmod", expr)], resultT);
    }
    case "lchmodSync": {
      if (args.length > 2) return null;
      const a = dynArgs([args[0], args[1]]);
      return a && chk("fs.lchmodSyncChk", a, DYN);
    }
    case "read": {
      // read(fd, buffer, offset, length, position, callback) — the
      // positional form's full ladder; options-object forms keep the
      // fence (their misuse arms are not in the target set).
      if (args.length < 4) return null;
      const a = dynArgs([
        args[0],
        args[1],
        args[2],
        args[3],
        args.length >= 6 ? args[4] : undefined,
      ]);
      return a && chk("fs.readChk", [...a, ladderFenceExpr(lowerer, "fs.read", expr)], resultT);
    }
    case "createReadStream":
    case "createWriteStream": {
      // The runtime streams (scr_fs_stream.c) run Node's checks; a third
      // argument keeps the ladder's fence.
      const a = dynArgs([args[0], args[1]]);
      if (a && args.length <= 2) {
        const readable = bi.member === "createReadStream";
        return {
          kind: "libCall",
          fn: readable ? "fs.createReadStream" : "fs.createWriteStream",
          args: a,
          type: { kind: "object", className: readable ? "%Readable" : "%Writable" },
          loc,
        };
      }
      return (
        a &&
        chk("fs.streamOptsChk", [...a, ladderFenceExpr(lowerer, `fs.${bi.member}`, expr)], resultT)
      );
    }
    default:
      return null;
  }
}

/** A valid string/byte overload must select its runtime entry from the live
 * union tag. Coercing the whole argument to the string overload loses bytes. */
export function lowerStringOrBytesWrite(
  lowerer: Lowerer,
  call: ts.CallExpression,
  dataType: Extract<IrType, { kind: "union" }>,
  arms: readonly IrType[],
  append: boolean,
): IrExpr {
  const loc = locOf(call);
  const key = `fs.${append ? "append" : "write"}:${dataType.unionId}`;
  let helper = lowerer.valueHelpers.get(key);
  if (!helper) {
    helper = keyedHelperName(lowerer, "%fs.writeData", key);
    lowerer.valueHelpers.set(key, helper);
    const body: IrStmt[] = [];
    for (let tag = 0; tag < arms.length; tag++) {
      const arm = arms[tag]!;
      const fn: IrLibFn =
        arm.kind === "bytes"
          ? append
            ? "fs.appendFileSyncBytes"
            : "fs.writeFileSyncBytes"
          : append
            ? "fs.appendFileSync"
            : "fs.writeFileSync";
      body.push({
        kind: "if",
        loc,
        cond: {
          kind: "unionIsTag",
          unionId: dataType.unionId,
          tag,
          negated: false,
          value: varRef("data.0", dataType, loc),
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn,
              args: [
                varRef("path.0", STRING, loc),
                {
                  kind: "unionNarrow",
                  unionId: dataType.unionId,
                  tag,
                  value: varRef("data.0", dataType, loc),
                  type: arm,
                  loc,
                },
              ],
              type: VOID,
              loc,
            },
            loc,
          },
          { kind: "return", value: null, loc },
        ],
        else_: null,
      });
    }
    body.push({ kind: "return", value: null, loc });
    lowerer.liftedFns.push({
      name: helper,
      returnType: VOID,
      loc,
      params: [
        { localId: "path.0", name: "path", type: STRING },
        { localId: "data.0", name: "data", type: dataType },
      ],
      locals: [
        { id: "path.0", name: "path", type: STRING, mutable: false },
        { id: "data.0", name: "data", type: dataType, mutable: false },
      ],
      body,
    });
  }
  return {
    kind: "call",
    callee: helper,
    args: [
      lowerFsPath(lowerer, call.arguments.nodes[0]!),
      lowerer.lowerExprExpecting(call.arguments.nodes[1]!, dataType),
    ],
    type: VOID,
    loc,
  };
}

/** Calls on an fs/promises FileHandle. The promise-returning methods run
 * through the same synchronous descriptor primitives as fs.readSync /
 * writeSync, then settle so failures reject at await. read/write retain
 * the caller's buffer in the Node-shaped result record. */
export function lowerFileHandleMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "fileHandle") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const receiver = (): IrExpr => lowerer.lowerExprExpecting(access.expression, FILEHANDLE_T);
  const promise = (inner: IrType): IrType => ({ kind: "promise", inner });
  if (name === "createReadStream" || name === "createWriteStream" || name === "readLines") {
    return lowerFileHandleStreamCall(lowerer, call, name, receiver(), loc);
  }
  const num = (
    node: ts.Expression | undefined,
    dflt: number,
    lowered?: IrExpr,
  ): { value: IrExpr; defaulted: IrExpr } => {
    const defaultValue: IrExpr = { kind: "numLit", value: dflt, type: F64, loc };
    if (!node && !lowered) return { value: defaultValue, defaulted: boolLit(true, loc) };
    if (lowered && isUnitType(lowered.type)) {
      return { value: defaultAfterUndefined(lowered, defaultValue), defaulted: boolLit(true, loc) };
    }
    const undefinedArg = !lowered && node ? lowerStaticallyUndefinedArgument(lowerer, node) : null;
    if (undefinedArg) {
      return {
        value: defaultAfterUndefined(undefinedArg, defaultValue),
        defaulted: boolLit(true, loc),
      };
    }
    if (!lowered && node && (lowerer.typeOf(node).flags & ts.TypeFlags.Null) !== 0) {
      return {
        value: defaultAfterUndefined(lowerer.lowerExpr(node), defaultValue),
        defaulted: boolLit(true, loc),
      };
    }
    const value = lowered ?? lowerer.lowerExpr(node!);
    if (value.type.kind === "union") {
      const def = lowerer.unions.get(value.type.unionId);
      const units = def?.arms.filter(isUnitType) ?? [];
      if (units.length > 0 && def?.arms.every((arm) => typeEquals(arm, F64) || isUnitType(arm))) {
        // The normalized number and the separate "length was omitted"
        // bit must observe one evaluation of a runtime optional union.
        // Bind it in the numeric argument; the later bool argument reads
        // the same hidden local (libCall arguments evaluate left-to-right).
        const saved = lowerer.declareHiddenLocal("%fhOptNum", value.type);
        const savedRef = (): IrExpr => ({
          kind: "varRef",
          localId: saved.id,
          type: value.type,
          loc: value.loc,
        });
        let defaulted: IrExpr = {
          kind: "unionIsTag",
          unionId: value.type.unionId,
          tag: lowerer.armTag(value.type.unionId, units[0]!),
          negated: false,
          value: savedRef(),
          type: BOOL,
          loc: value.loc,
        };
        for (const unit of units.slice(1)) {
          defaulted = {
            kind: "logical",
            op: "||",
            left: defaulted,
            right: {
              kind: "unionIsTag",
              unionId: value.type.unionId,
              tag: lowerer.armTag(value.type.unionId, unit),
              negated: false,
              value: savedRef(),
              type: BOOL,
              loc: value.loc,
            },
            type: BOOL,
            loc: value.loc,
          };
        }
        return {
          value: {
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: saved.id, init: value, loc: value.loc }],
            result: {
              kind: "nullish",
              left: savedRef(),
              right: defaultValue,
              type: F64,
              loc: value.loc,
            },
            type: F64,
            loc: value.loc,
          },
          defaulted,
        };
      }
    }
    return { value: lowerer.coerceInto(node ?? call, value, F64), defaulted: boolLit(false, loc) };
  };
  const utf8 = (node: ts.Expression | undefined): IrExpr => {
    const dflt = { kind: "strLit", value: "utf8", type: STRING, loc } satisfies IrExpr;
    if (!node) return dflt;
    const nodeType = lowerer.typeOf(node);
    const parts: readonly ts.Type[] = nodeType.isUnionType()
      ? ts.constituentTypes(nodeType)
      : [nodeType];
    const supported = parts.every(
      (t) =>
        (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0 ||
        (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")),
    );
    if (!supported) {
      lowerer.noLowering(
        `FileHandle.${name} with a non-utf8 encoding`,
        node,
        "only utf8 data is supported",
      );
    }
    return lowerBuiltinOptionalDefault(lowerer, node, STRING, dflt, true);
  };

  if (name === "sync" || name === "datasync") {
    if (call.arguments.nodes.length !== 0)
      lowerer.noLowering(`FileHandle.${name} with arguments`, call);
    return {
      kind: "libCall",
      fn: name === "sync" ? "fileHandle.sync" : "fileHandle.datasync",
      args: [receiver()],
      type: promise(VOID),
      loc,
    };
  }
  if (name === "truncate" || name === "chmod") {
    if (call.arguments.nodes.length > 1 || (name === "chmod" && call.arguments.nodes.length !== 1))
      lowerer.noLowering(`FileHandle.${name} with ${call.arguments.nodes.length} arguments`, call);
    return {
      kind: "libCall",
      fn: name === "truncate" ? "fileHandle.truncate" : "fileHandle.chmod",
      args: [receiver(), num(call.arguments.nodes[0], 0).value],
      type: promise(VOID),
      loc,
    };
  }
  if (name === "utimes") {
    if (call.arguments.nodes.length !== 2 || call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("FileHandle.utimes with this argument shape", call);
    return {
      kind: "libCall",
      fn: "fileHandle.utimes",
      args: [
        receiver(),
        lowerFsTimestampValue(lowerer, call.arguments.nodes[0], loc),
        lowerFsTimestampValue(lowerer, call.arguments.nodes[1], loc),
      ],
      type: promise(VOID),
      loc,
    };
  }
  if (name === "readv" || name === "writev") {
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 2)
      lowerer.noLowering(`FileHandle.${name} with ${call.arguments.nodes.length} arguments`, call);
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (type?.kind !== "promise" || type.inner.kind !== "record")
      lowerer.badType(call, lowerer.typeOf(call));
    return {
      kind: "libCall",
      fn: name === "readv" ? "fileHandle.readv" : "fileHandle.writev",
      args: [
        receiver(),
        lowerer.lowerExprExpecting(call.arguments.nodes[0]!, arrayOf(BYTES_U8)),
        num(call.arguments.nodes[1], -1).value,
      ],
      type,
      loc,
    };
  }
  if (name === "close" || name === "stat") {
    if (call.arguments.nodes.length !== 0)
      lowerer.noLowering(`FileHandle.${name} with arguments`, call);
    return {
      kind: "libCall",
      fn: name === "close" ? "fileHandle.close" : "fileHandle.stat",
      args: [receiver()],
      type: promise(name === "close" ? VOID : { kind: "stats" }),
      loc,
    };
  }

  if (name === "readFile") {
    if (call.arguments.nodes.length > 1) {
      lowerer.noLowering(`FileHandle.readFile with ${call.arguments.nodes.length} arguments`, call);
    }
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (type?.kind !== "promise") lowerer.badType(call, lowerer.typeOf(call));
    const encoding = utf8(call.arguments.nodes[0]);
    if (typeEquals(type.inner, BYTES_U8)) {
      return {
        kind: "libCall",
        fn: "fileHandle.readFileBytes",
        args: [receiver(), encoding],
        type,
        loc,
      };
    }
    if (!typeEquals(type.inner, STRING)) lowerer.badType(call, lowerer.typeOf(call));
    return {
      kind: "libCall",
      fn: "fileHandle.readFile",
      args: [receiver(), encoding],
      type,
      loc,
    };
  }

  if (name === "writeFile" || name === "appendFile") {
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 2) {
      lowerer.noLowering(`FileHandle.${name} with ${call.arguments.nodes.length} arguments`, call);
    }
    const dataNode = call.arguments.nodes[0]!;
    const dataT = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
    // Evaluate a supplied utf8 encoding even for Buffer data, matching
    // Node's argument order; it does not affect the bytes.
    const encoding = utf8(call.arguments.nodes[1]);
    if (dataT?.kind === "string") {
      return {
        kind: "libCall",
        fn: "fileHandle.writeFile",
        args: [receiver(), lowerer.lowerExprExpecting(dataNode, STRING), encoding],
        type: promise(VOID),
        loc,
      };
    }
    if (dataT?.kind === "bytes" && dataT.elem === "u8") {
      return {
        kind: "libCall",
        fn: "fileHandle.writeFileBytes",
        args: [receiver(), lowerer.lowerExprExpecting(dataNode, BYTES_U8), encoding],
        type: promise(VOID),
        loc,
      };
    }
    lowerer.noLowering(
      `FileHandle.${name} of '${dataT ? lowerer.fmt(dataT) : lowerer.checker.typeToString(lowerer.typeOf(dataNode))}' data`,
      dataNode,
      "string and Uint8Array data are supported",
    );
  }

  if (name === "read" || name === "write") {
    const firstNode = call.arguments.nodes[0];
    const firstT = firstNode ? lowerer.mapTypeOf(lowerer.typeOf(firstNode)) : undefined;
    const secondT = call.arguments.nodes[1]
      ? lowerer.mapTypeOf(lowerer.typeOf(call.arguments.nodes[1]!))
      : undefined;
    const readOptions =
      name === "read" &&
      (!firstNode || firstT?.kind === "record" || (firstT && isUnitType(firstT)));
    const bufferOptions =
      firstT?.kind === "bytes" && firstT.elem === "u8" && secondT?.kind === "record";
    if (readOptions || bufferOptions) {
      if (call.arguments.nodes.length > (bufferOptions ? 2 : 1))
        lowerer.noLowering(`FileHandle.${name} options with extra arguments`, call);
      const type = lowerer.mapTypeOf(lowerer.typeOf(call));
      if (type?.kind !== "promise" || type.inner.kind !== "record")
        lowerer.badType(call, lowerer.typeOf(call));
      const stmts: IrStmt[] = [];
      const stage = (value: IrExpr, label: string): IrExpr => {
        const local = lowerer.declareHiddenLocal(label, value.type);
        stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
        return varRef(local.id, local.type, loc);
      };
      const handle = stage(receiver(), "%fhWindowReceiver");
      let buffer = bufferOptions
        ? stage(lowerer.lowerExprExpecting(firstNode!, BYTES_U8), "%fhWindowBuffer")
        : undefined;
      const optionsNode = bufferOptions ? call.arguments.nodes[1] : firstNode;
      const options = optionsNode
        ? stage(lowerer.lowerExpr(optionsNode), "%fhWindowOptions")
        : undefined;
      const field = (key: string): IrExpr | undefined => {
        if (options?.type.kind !== "record") return undefined;
        const fields = lowerer.shapes.get(options.type.shapeId)?.fields;
        const getter = fields?.find((f) => f.name === `%get:${key}`);
        if (getter?.type.kind === "func") {
          const callee: IrExpr = {
            kind: "recordGet",
            obj: options,
            shapeId: options.type.shapeId,
            field: getter.name,
            type: getter.type,
            loc,
          };
          return { kind: "callValue", callee, args: [], type: getter.type.ret, loc };
        }
        const member = fields?.find((f) => f.name === key);
        return member
          ? {
              kind: "recordGet",
              obj: options,
              shapeId: options.type.shapeId,
              field: key,
              type: member.type,
              loc,
            }
          : undefined;
      };
      if (!buffer) {
        const supplied = field("buffer");
        const fresh: IrExpr = { kind: "bytesNew", source: numLit(16384, loc), type: BYTES_U8, loc };
        if (!supplied || isUnitType(supplied.type))
          buffer = supplied ? defaultAfterUndefined(supplied, fresh) : fresh;
        else if (supplied.type.kind === "union") {
          const arms = lowerer.unions.get(supplied.type.unionId)?.arms;
          if (!arms?.every((arm) => typeEquals(arm, BYTES_U8) || isUnitType(arm)))
            lowerer.noLowering("FileHandle.read with this buffer type", call);
          buffer = { kind: "nullish", left: supplied, right: fresh, type: BYTES_U8, loc };
        } else buffer = lowerer.coerceInto(call, supplied, BYTES_U8);
        buffer = stage(buffer, "%fhWindowBuffer");
      }
      const offset = num(undefined, 0, field("offset"));
      const length = num(undefined, -1, field("length"));
      const position = num(undefined, -1, field("position"));
      const result: IrExpr = {
        kind: "libCall",
        fn: name === "read" ? "fileHandle.read" : "fileHandle.writeBytes",
        args: [handle, buffer, offset.value, length.value, position.value, length.defaulted],
        type,
        loc,
      };
      return { kind: "seqExpr", stmts, result, type, loc };
    }
  }

  if (name === "read") {
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 4) {
      lowerer.noLowering(
        `FileHandle.read with ${call.arguments.nodes.length} arguments`,
        call,
        "use read(buffer[, offset[, length[, position]]])",
      );
    }
    const buffer = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, BYTES_U8);
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (type?.kind !== "promise" || type.inner.kind !== "record") {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    const offset = num(call.arguments.nodes[1], 0);
    const length = num(call.arguments.nodes[2], -1);
    const position = num(call.arguments.nodes[3], -1);
    return {
      kind: "libCall",
      fn: "fileHandle.read",
      args: [receiver(), buffer, offset.value, length.value, position.value, length.defaulted],
      type,
      loc,
    };
  }

  if (name === "write") {
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 4) {
      lowerer.noLowering(`FileHandle.write with ${call.arguments.nodes.length} arguments`, call);
    }
    const dataNode = call.arguments.nodes[0]!;
    const dataT = lowerer.mapTypeOf(lowerer.typeOf(dataNode));
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (type?.kind !== "promise" || type.inner.kind !== "record") {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    if (dataT?.kind === "bytes" && dataT.elem === "u8") {
      const offset = num(call.arguments.nodes[1], 0);
      const length = num(call.arguments.nodes[2], -1);
      const position = num(call.arguments.nodes[3], -1);
      return {
        kind: "libCall",
        fn: "fileHandle.writeBytes",
        args: [
          receiver(),
          lowerer.lowerExprExpecting(dataNode, BYTES_U8),
          offset.value,
          length.value,
          position.value,
          length.defaulted,
        ],
        type,
        loc,
      };
    }
    if (dataT?.kind === "string") {
      if (call.arguments.nodes.length > 3) {
        lowerer.noLowering(
          `FileHandle.write(string) with ${call.arguments.nodes.length} arguments`,
          call,
          'use write(string[, position[, "utf8"]])',
        );
      }
      const position = num(call.arguments.nodes[1], -1);
      return {
        kind: "libCall",
        fn: "fileHandle.writeStr",
        args: [
          receiver(),
          lowerer.lowerExprExpecting(dataNode, STRING),
          position.value,
          utf8(call.arguments.nodes[2]),
        ],
        type,
        loc,
      };
    }
    lowerer.noLowering(
      `FileHandle.write of '${dataT ? lowerer.fmt(dataT) : lowerer.checker.typeToString(lowerer.typeOf(dataNode))}' data`,
      dataNode,
      "string and Uint8Array data are supported",
    );
  }

  lowerer.noLowering(
    `FileHandle.${name}`,
    call,
    "fd, close(), read(), write(), readv(), writev(), readFile(), writeFile(), appendFile(), stat(), sync(), datasync(), truncate(), and chmod() are the supported FileHandle members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** FileHandle.createReadStream / createWriteStream(options?) and
 * readLines(options?): the options cross as one dyn value (the runtime
 * spreads an options object, as Node's `{ ...options, fd: this }` does).
 * readLines is `new readline.Interface({ input: createReadStream(options),
 * crlfDelay: Infinity })`. */
function lowerFileHandleStreamCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: "createReadStream" | "createWriteStream" | "readLines",
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement) || args.length > 1) {
    lowerer.noLowering(`FileHandle.${name} with ${args.length} arguments`, call);
  }
  let options: IrExpr = dynUndefinedExpr(loc);
  if (args[0] !== undefined) {
    const raw = lowerer.lowerExpr(args[0]);
    if (raw.type.kind === "dyn") options = raw;
    else if (raw.kind === "unitLit" || lowerer.dynConvertible(raw.type)) {
      options = { kind: "dynFrom", value: raw, type: DYN, loc };
    } else {
      lowerer.noLowering(
        `FileHandle.${name} with a '${lowerer.fmt(raw.type)}' options value`,
        args[0],
        "the options are a plain object",
      );
    }
  }
  const writable = name === "createWriteStream";
  const stream: IrExpr = {
    kind: "libCall",
    fn: writable ? "fileHandle.createWriteStream" : "fileHandle.createReadStream",
    args: [receiver, options],
    type: { kind: "object", className: writable ? "%Writable" : "%Readable" },
    loc,
  };
  if (name !== "readLines") return stream;
  // rl.create's mode 1: an input stream, no output, then crlfDelay.
  return {
    kind: "libCall",
    fn: "rl.create",
    args: [
      { kind: "numLit", value: 1, type: F64, loc },
      stream,
      { kind: "numLit", value: Infinity, type: F64, loc },
    ],
    type: F64,
    loc,
  };
}

/** fs.Dir's members: path, and the sync and promise read/close forms (the
 * callback overloads have no lowering; for-await lowers in
 * lower-async-iteration.ts). */
export const DIR_METHODS = new Set(["readSync", "read", "closeSync", "close"]);
export const DIR_MEMBERS =
  "path, readSync(), read(), closeSync(), close(), and for-await iteration are the supported Dir members (no callbacks)";

/** Method calls on Dir-typed receivers. readSync answers the call site's
 * `Dirent | null` (the emitter builds the row); read is its promise twin.
 * Null for non-Dir receivers. */
export function lowerDirMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "dir") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (DIR_METHODS.has(name) && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExprExpecting(access.expression, DIR_T);
    if (name === "closeSync")
      return { kind: "libCall", fn: "dir.closeSync", args: [receiver], type: VOID, loc };
    if (name === "close") {
      return {
        kind: "libCall",
        fn: "dir.close",
        args: [receiver],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    const type = lowerer.mapTypeOf(lowerer.typeOf(call));
    const entry = type?.kind === "promise" ? type.inner : type;
    const arms = entry?.kind === "union" ? lowerer.unions.get(entry.unionId)?.arms : undefined;
    if (
      type &&
      arms?.length === 2 &&
      arms.some((arm) => arm.kind === "record") &&
      arms.some((arm) => arm.kind === "nullT") &&
      (name === "read") === (type.kind === "promise")
    ) {
      return {
        kind: "libCall",
        fn: name === "read" ? "dir.read" : "dir.readSync",
        args: [receiver],
        type,
        loc,
      };
    }
  }
  return lowerer.noLowering(
    `Dir.${name}`,
    call,
    DIR_MEMBERS,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The Stats type tests, each a read of the snapshot's mode. */
export const STATS_TYPE_TESTS: Record<string, IrLibFn> = {
  isFile: "stats.isFile",
  isDirectory: "stats.isDirectory",
  isSymbolicLink: "stats.isSymbolicLink",
  isBlockDevice: "stats.isBlockDevice",
  isCharacterDevice: "stats.isCharacterDevice",
  isFIFO: "stats.isFIFO",
  isSocket: "stats.isSocket",
};

/** Method calls on Stats-typed receivers: the type tests are pure reads on
 * the stat snapshot (a followed statSync snapshot never answers true to
 * isSymbolicLink — take lstatSync's, Node's own split). Anything else
 * fences member-qualified. Null for non-Stats receivers. */
export function lowerStatsMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  // `stat?.isFile()` on a `Stats | undefined` receiver: the optional-chain
  // lowering guards the receiver, then re-enters here with it narrowed.
  if (
    (call.questionDotToken && !lowerer.chainHandled.has(call)) ||
    (access.questionDotToken && !lowerer.chainHandled.has(access))
  ) {
    return null;
  }
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "stats") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const fn = Object.hasOwn(STATS_TYPE_TESTS, name) ? STATS_TYPE_TESTS[name] : undefined;
  if (fn && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn, args: [receiver], type: BOOL, loc: locOf(call) };
  }
  lowerer.noLowering(
    `Stats.${name}`,
    call,
    "isFile(), isDirectory(), isSymbolicLink(), isBlockDevice(), isCharacterDevice(), isFIFO(), isSocket(), dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs, atime, mtime, ctime, and birthtime are the supported Stats members",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** `fs.watch(path[, options][, listener])` → the fs.watch libCall
 * (scr_watch.c — kqueue EVFILT_VNODE on the opened path; an unopenable
 * path THROWS Node's fs error synchronously, the polling-fallback catch
 * shape). The listener fires with "rename"/"change" and takes zero
 * parameters or the eventType string — the filename parameter has no
 * lowering (kqueue watches the inode, not the directory entry; you
 * watched one path). The options record follows the options-record
 * stance: persistent: true, recursive: false, and encoding: "utf8"
 * state the lowered behavior and are accepted; persistent: false
 * (a watcher that does NOT hold the loop), recursive: true (kqueue
 * watches one inode), signal, and non-utf8 encodings fence by name;
 * undocumented keys drop like Node. An open watcher keeps the loop
 * alive until watcher.close(). */
export function lowerFsWatchCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (
    expr.arguments.nodes.length < 1 ||
    expr.arguments.nodes.length > 3 ||
    expr.arguments.nodes.some(ts.isSpreadElement)
  ) {
    lowerer.noLowering(
      "fs.watch with this argument shape",
      expr,
      "the supported forms are watch(path[, options][, listener])",
    );
  }
  const hasOptions =
    expr.arguments.nodes.length >= 2 && ts.isObjectLiteralExpression(expr.arguments.nodes[1]!);
  if (expr.arguments.nodes.length === 3 && !hasOptions) {
    lowerer.noLowering(
      "fs.watch with a non-literal options argument",
      expr.arguments.nodes[1]!,
      "pass the options as an object literal: watch(path, { recursive?, persistent?, encoding? }, listener)",
    );
  }
  if (hasOptions) {
    for (const prop of (expr.arguments.nodes[1] as ts.ObjectLiteralExpression).properties.nodes) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
        lowerer.noLowering(
          "fs.watch options with computed keys or spreads",
          prop,
          "each option must be a plain `name: value` entry with a literal key",
        );
      }
      if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) {
        lowerer.noLowering(
          "fs.watch options with computed keys",
          prop,
          "each option must be a plain `name: value` entry with a literal key",
        );
      }
      const key = prop.name.text;
      const init = ts.isPropertyAssignment(prop) ? prop.initializer : null;
      if (key === "persistent") {
        // true IS the lowering (an open watcher holds the loop) —
        // stating the default is a no-op; false has no lowering.
        if (init !== null && init.kind === ts.SyntaxKind.TrueKeyword) continue;
        lowerer.noLowering(
          "fs.watch with persistent disabled",
          prop,
          "an open watcher keeps the loop alive until close() — that IS the lowering; " +
            "persistent: false (a watcher the process does not wait for) has no lowering",
        );
      }
      if (key === "recursive") {
        if (init !== null && init.kind === ts.SyntaxKind.FalseKeyword) continue;
        lowerer.noLowering(
          "fs.watch with the recursive option",
          prop,
          "recursive watching has no lowering yet — kqueue watches the one opened path; watch each path",
        );
      }
      if (key === "encoding") {
        const enc = init !== null && ts.isStringLiteralLike(init) ? init.text : null;
        if (enc === "utf8" || enc === "utf-8") continue;
        lowerer.noLowering(
          "fs.watch with a non-utf8 encoding",
          prop,
          "the encoding applies to the filename argument, which has no lowering — utf8 (the default) is accepted",
        );
      }
      if (key === "signal") {
        lowerer.noLowering(
          "fs.watch with an abort signal",
          prop,
          "abortable watchers have no lowering — call watcher.close() instead",
        );
      }
      fenceOrDropOptionKey(
        lowerer,
        prop,
        key,
        "fs.watch",
        FS_WATCH_DOCUMENTED_OPTIONS,
        'persistent: true, recursive: false, and encoding: "utf8" are the accepted options',
      );
      // An undocumented key, dropped like Node drops it.
    }
  }
  const path = lowerer.lowerExprExpecting(expr.arguments.nodes[0]!, STRING);
  const args: IrExpr[] = [path];
  const listenerArg = hasOptions
    ? expr.arguments.nodes.length === 3
      ? expr.arguments.nodes[2]!
      : null
    : expr.arguments.nodes.length === 2
      ? expr.arguments.nodes[1]!
      : null;
  if (listenerArg !== null) {
    const cb = lowerer.lowerExpr(listenerArg);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.noLowering(
        "fs.watch with this listener shape",
        listenerArg,
        "the listener takes () or (eventType: string) — the filename parameter has no lowering (you watched one path)",
      );
    }
    const param = cb.type.params[0];
    if (param !== undefined && param.kind !== "string") {
      lowerer.unsupported(
        "SC1090",
        listenerArg,
        `watch listeners whose parameter is not the eventType string (got '${lowerer.fmt(param)}')`,
      );
    }
    args.push(cb);
  }
  return {
    kind: "libCall",
    fn: args.length === 2 ? "fs.watchCb" : "fs.watch",
    args,
    type: FSWATCHER_T,
    loc,
  };
}

/** Method calls on FSWatcher receivers: close() — idempotent, statement
 * position (Node returns void there too). Everything else @types/node
 * declares (ref/unref, the EventEmitter surface) fences member-
 * qualified. Null for non-watcher receivers. */
export function lowerWatcherMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "fsWatcher") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "close" && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "watcher.close", args: [receiver], type: VOID, loc };
  }
  lowerer.noLowering(
    `FSWatcher.${name}`,
    call,
    "close() is the supported FSWatcher member",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** `os.networkInterfaces()` — getifaddrs(3) behind Node's exact result
 * type. The libCall's type is the CALL SITE's mapped
 * `NodeJS.Dict<NetworkInterfaceInfo[]>`: a pure index-signature record
 * whose value is `Info[] | undefined`, Info the two-record union
 * @types/node declares (IPv4: `scopeid?: number` — the undefined-armed
 * union — and IPv6: `scopeid: number`; family literal types collapse to
 * string in both). The emitter derives every shape/union/tag from that
 * type, so the structure is verified HERE and anything else (an older
 * @types/node, a user alias reshaping the result) fences honestly. Key
 * and row order follow getifaddrs enumeration — Node itself guarantees
 * no order (compare structurally). */
/** `fs.readdirSync` / `fs.promises.readdir` with `{ withFileTypes: true }`
 * — Dirent rows: name + parentPath (the path argument as given, Node's
 * own rule) + the hidden %dtype entry kind (libuv's UV_DIRENT encoding;
 * DT_UNKNOWN falls back to lstat, Node's getDirents rule). The options
 * literal is checked member-by-member; the result type must carry the
 * interned Dirent record array from type-mapper.ts — anything else
 * (encoding: 'buffer', a user alias reshaping Dirent) fences honestly. */
export function lowerFsReaddirTypesCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
  promiseForm: boolean,
): IrExpr {
  const operation = promiseForm ? "fs.promises.readdir" : "readdirSync";
  const spelling = promiseForm ? "readdir" : "readdirSync";
  const optsNode = call.arguments.nodes[1]!;
  if (!ts.isObjectLiteralExpression(optsNode)) {
    lowerer.noLowering(
      `${operation} with a non-literal options argument`,
      optsNode,
      `pass the options inline so each member can be checked: ${spelling}(path, { withFileTypes: true })`,
    );
  }
  let sawWithFileTypes = false;
  let recursive: ts.Expression | null = null;
  for (const p of optsNode.properties.nodes) {
    const m = optionMember(p);
    if (!m) {
      lowerer.noLowering(
        `${operation} with this options shape`,
        p,
        "spreads and computed keys have no lowering — write each member inline",
      );
    }
    if (m.name === "withFileTypes") {
      const t = lowerer.typeOf(m.value);
      if (!(t.flags & ts.TypeFlags.BooleanLiteral) || lowerer.checker.typeToString(t) !== "true") {
        lowerer.noLowering(
          `${operation} with a non-literal-true withFileTypes`,
          m.value,
          "withFileTypes: true is the Dirent form; omit the options for plain names",
        );
      }
      sawWithFileTypes = true;
    } else if (m.name === "encoding") {
      const t = lowerer.typeOf(m.value);
      if (!t.isStringLiteralType() || (t.value !== "utf8" && t.value !== "utf-8")) {
        lowerer.noLowering(
          `${operation} with a non-utf8 encoding`,
          m.value,
          "names decode as utf8 (the default); encoding: 'buffer' has no lowering",
        );
      }
    } else if (m.name === "recursive" && !promiseForm) {
      recursive = m.value;
    } else {
      // The options-record stance: recursive (a documented knob with
      // no lowering here) fences by name; undocumented keys drop like Node.
      fenceOrDropOptionKey(
        lowerer,
        p,
        m.name,
        operation,
        FS_READDIR_DOCUMENTED_OPTIONS,
        "withFileTypes: true (and the default encoding) is the supported options surface — recursive listings want an explicit walk",
      );
    }
  }
  if (recursive !== null) {
    // Only the `true`/`false` keywords fold; any other expression, even one
    // typed as a literal, evaluates at run time for its effects.
    let flag = recursive;
    while (ts.isParenthesizedExpression(flag)) flag = flag.expression;
    const literal =
      flag.kind === ts.SyntaxKind.TrueKeyword
        ? "true"
        : flag.kind === ts.SyntaxKind.FalseKeyword
          ? "false"
          : null;
    if (sawWithFileTypes && literal !== "false") {
      lowerer.noLowering(
        `${operation} with withFileTypes and recursive`,
        recursive,
        "recursive: true lists relative names; withFileTypes: true lists one directory's Dirents",
      );
    }
    if (!sawWithFileTypes) return lowerFsReaddirRecursive(lowerer, call, recursive, literal, loc);
  }
  if (!sawWithFileTypes) {
    lowerer.noLowering(
      `${operation} with 2 arguments`,
      call,
      `${spelling}(path) lists names; ${spelling}(path, { withFileTypes: true }) lists Dirents`,
    );
  }
  const fence: () => never = () =>
    lowerer.noLowering(
      `${operation}(path, { withFileTypes: true }) where the result is not the Dirent array`,
      call,
      "{ name, parentPath, isFile(), isDirectory(), isSymbolicLink() } rows are the supported result shape",
    );
  const callType = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (!callType) fence();
  let result = callType;
  if (promiseForm) {
    if (callType.kind !== "promise") fence();
    result = callType.inner;
  }
  if (result?.kind !== "array" || result.elem.kind !== "record") fence();
  const shape = lowerer.shapes.get(result.elem.shapeId);
  if (
    !shape ||
    shape.tuple ||
    shape.indexValue ||
    shape.fields.length !== 3 ||
    !shape.fields.some((f) => f.name === "%dtype")
  ) {
    fence();
  }
  const path = lowerFsPath(lowerer, call.arguments.nodes[0]!);
  return {
    kind: "libCall",
    fn: promiseForm ? "fsp.readdirTypes" : "fs.readdirTypesSync",
    args: [path],
    type: callType,
    loc,
  };
}

/** `fs.readdirSync(path, { recursive })` without withFileTypes: the
 * relative names of every entry below the path when `recursive` is true
 * (scr_fs_readdir_recursive, Node's queue order), the directory's own names
 * when it is false. A recursive flag that is not a boolean literal selects
 * between the two at run time, after the path is evaluated. */
function lowerFsReaddirRecursive(
  lowerer: Lowerer,
  call: ts.CallExpression,
  recursive: ts.Expression,
  literal: string | null,
  loc: SrcLoc,
): IrExpr {
  const names = arrayOf(STRING);
  // @types/node types the call `string[] | Buffer[]` when the options name
  // no encoding; the names are strings, so the call is the string[] arm.
  const callType = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (
    !callType ||
    !(
      typeEquals(callType, names) ||
      (callType.kind === "union" && lowerer.armTag(callType.unionId, names) >= 0)
    )
  ) {
    lowerer.noLowering(
      "readdirSync(path, { recursive }) where the result is not a string array",
      call,
      "names decode as utf8 strings (the default encoding)",
    );
  }
  return lowerFsReaddirNames(lowerer, call, recursive, literal, names, loc);
}

function lowerFsReaddirNames(
  lowerer: Lowerer,
  call: ts.CallExpression,
  recursive: ts.Expression,
  literal: string | null,
  names: IrType,
  loc: SrcLoc,
): IrExpr {
  const path = lowerFsPath(lowerer, call.arguments.nodes[0]!);
  const listing = (fn: IrLibFn, arg: IrExpr): IrExpr => ({
    kind: "libCall",
    fn,
    args: [arg],
    type: names,
    loc,
  });
  if (literal === "true") return listing("fs.readdirRecursiveSync", path);
  if (literal === "false") return listing("fs.readdirSync", path);
  const pathLocal = lowerer.declareHiddenLocal("%readdirPath", STRING);
  const pathRef = varRef(pathLocal.id, STRING, loc);
  const flag = lowerer.lowerExprExpecting(recursive, BOOL);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: pathLocal.id, init: path, loc }],
    result: {
      kind: "ternary",
      cond: flag,
      then: listing("fs.readdirRecursiveSync", pathRef),
      else_: listing("fs.readdirSync", pathRef),
      type: names,
      loc,
    },
    type: names,
    loc,
  };
}

/** fs.statSync / fs.lstatSync's documented option keys. */
const FS_STAT_DOCUMENTED_OPTIONS: ReadonlySet<string> = new Set(["bigint", "throwIfNoEntry"]);

/** fs.statSync / fs.lstatSync(path, options). The options are an object
 * literal, where throwIfNoEntry takes any boolean and bigint must be a
 * literal false (BigIntStats has no lowering), or a stored record whose
 * only member is a boolean throwIfNoEntry. When the call's type is
 * `Stats | undefined`, the call lowers to the probe, which answers
 * undefined for a missing entry without building the error. An explicitly
 * undefined options argument is the one-argument form. */
export function lowerFsStatOptionsCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
  noFollow: boolean,
): IrExpr {
  const spelling = noFollow ? "lstatSync" : "statSync";
  const plainFn: IrLibFn = noFollow ? "fs.lstatSync" : "fs.statSync";
  const optsNode = call.arguments.nodes[1]!;
  const path = lowerFsPath(lowerer, call.arguments.nodes[0]!);
  // The path binds first, then the options' effects, then the stat runs.
  const plainAfter = (effect: IrExpr | null): IrExpr => {
    if (effect === null) return { kind: "libCall", fn: plainFn, args: [path], type: STATS_T, loc };
    const pathLocal = lowerer.declareHiddenLocal("%statPath", STRING);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: pathLocal.id, init: path, loc: path.loc },
        { kind: "exprStmt", expr: effect, loc: effect.loc },
      ],
      result: {
        kind: "libCall",
        fn: plainFn,
        args: [varRef(pathLocal.id, STRING, loc)],
        type: STATS_T,
        loc,
      },
      type: STATS_T,
      loc,
    };
  };
  const undefinedOptions = lowerStaticallyUndefinedArgument(lowerer, optsNode);
  if (undefinedOptions !== null) {
    return plainAfter(isSafeToDiscard(undefinedOptions) ? null : undefinedOptions);
  }
  let throwIfNoEntry: IrExpr | null = null;
  if (!ts.isObjectLiteralExpression(optsNode)) {
    // A stored options record (`const statSyncOptions = { throwIfNoEntry:
    // false }`): the flag is read from it at the call, as Node reads
    // options.throwIfNoEntry.
    const optsType = lowerer.mapTypeOf(lowerer.typeOf(optsNode));
    const shape = optsType?.kind === "record" ? lowerer.shapes.get(optsType.shapeId) : undefined;
    const field = shape?.fields.find((f) => f.name === "throwIfNoEntry");
    if (
      optsType?.kind !== "record" ||
      !shape ||
      shape.tuple ||
      shape.indexValue ||
      shape.fields.length !== 1 ||
      field?.type.kind !== "bool"
    ) {
      lowerer.noLowering(
        `${spelling} with this options value`,
        optsNode,
        `pass an object literal, or a record whose only member is a boolean throwIfNoEntry: ${spelling}(path, { throwIfNoEntry: false })`,
      );
    }
    const opts = lowerer.lowerExpr(optsNode);
    if (opts.type.kind === "record") {
      throwIfNoEntry = {
        kind: "recordGet",
        obj: opts,
        shapeId: opts.type.shapeId,
        field: "throwIfNoEntry",
        type: BOOL,
        loc,
      };
    } else if (opts.type.kind === "dyn") {
      // A JavaScript binding held as a dynamic value: Node keeps throwing
      // unless the member is exactly false.
      throwIfNoEntry = {
        kind: "dynScalarEq",
        left: {
          kind: "dynKeyGet",
          key: { kind: "strLit", value: "throwIfNoEntry", type: STRING, loc },
          optional: true,
          value: opts,
          type: DYN,
          loc,
        },
        right: boolLit(false, loc),
        negated: true,
        type: BOOL,
        loc,
      };
    } else {
      lowerer.noLowering(`${spelling} with this options value`, optsNode, "pass an object literal");
    }
  }
  for (const p of ts.isObjectLiteralExpression(optsNode) ? optsNode.properties.nodes : []) {
    const m = optionMember(p);
    if (!m) {
      lowerer.noLowering(
        `${spelling} with this options shape`,
        p,
        "spreads and computed keys have no lowering — write each member inline",
      );
    }
    if (m.name === "throwIfNoEntry") {
      throwIfNoEntry = lowerer.lowerExprExpecting(m.value, BOOL);
    } else if (m.name === "bigint") {
      const t = lowerer.typeOf(m.value);
      if (!(t.flags & ts.TypeFlags.BooleanLiteral) || lowerer.checker.typeToString(t) !== "false") {
        lowerer.noLowering(
          `${spelling} with bigint: true`,
          m.value,
          "BigIntStats has no lowering; omit bigint for Stats",
        );
      }
    } else {
      fenceOrDropOptionKey(
        lowerer,
        p,
        m.name,
        spelling,
        FS_STAT_DOCUMENTED_OPTIONS,
        "throwIfNoEntry and bigint: false are the supported options",
      );
    }
  }
  const callType = lowerer.mapTypeOf(lowerer.typeOf(call));
  if (callType?.kind === "stats") {
    // A runtime flag that is false answers undefined, which a Stats result
    // cannot hold.
    if (throwIfNoEntry !== null && !(throwIfNoEntry.kind === "boolLit" && throwIfNoEntry.value)) {
      lowerer.noLowering(
        `${spelling} with a runtime-valued throwIfNoEntry where the result is typed Stats`,
        call,
        "the result must be Stats | undefined when throwIfNoEntry may be false",
      );
    }
    return plainAfter(null);
  }
  const def = callType?.kind === "union" ? lowerer.unions.get(callType.unionId) : undefined;
  if (
    !def ||
    def.arms.length !== 2 ||
    !def.arms.some((a) => a.kind === "stats") ||
    !def.arms.some((a) => a.kind === "undefinedT")
  ) {
    lowerer.noLowering(
      `${spelling}(path, options) where the result is not Stats or Stats | undefined`,
      call,
      `${spelling}(path, { throwIfNoEntry: false }) answers Stats | undefined`,
    );
  }
  return {
    kind: "libCall",
    fn: noFollow ? "fs.lstatProbeSync" : "fs.statProbeSync",
    args: [path, throwIfNoEntry ?? boolLit(true, loc)],
    type: callType!,
    loc,
  };
}

/** `d.isFile()` / `d.isDirectory()` / `d.isSymbolicLink()` on a Dirent-
 * typed receiver (the interned record — provenance via the checker's
 * Dirent symbol, the StringDecoder pattern): a read of the hidden
 * %dtype field compared against libuv's UV_DIRENT code. Node's other
 * type probes (isBlockDevice, ...) fence with the supported list. */
export function lowerDirentMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const recvSym = lowerer.typeOf(access.expression).getSymbol();
  if (recvSym === undefined || ts.symbolName(recvSym) !== "Dirent") return null;
  const receiver = lowerer.lowerExpr(access.expression);
  if (receiver.type.kind !== "record") return null;
  const shape = lowerer.shapes.get(receiver.type.shapeId);
  if (!shape?.fields.some((f) => f.name === "%dtype")) return null;
  const name = access.name.text;
  const loc = locOf(call);
  // libuv's UV_DIRENT encoding (scr_fs_scandir answers it).
  const code =
    name === "isFile" ? 1 : name === "isDirectory" ? 2 : name === "isSymbolicLink" ? 3 : -1;
  if (code < 0) {
    lowerer.noLowering(
      `Dirent.${name}`,
      call,
      "name, parentPath, isFile(), isDirectory(), and isSymbolicLink() are the supported Dirent members",
      lowerer.checker.getSymbolAtLocation(access.name),
    );
  }
  if (call.arguments.nodes.length !== 0) lowerer.noLowering(`Dirent.${name} with arguments`, call);
  const dtype: IrExpr = {
    kind: "recordGet",
    obj: receiver,
    shapeId: receiver.type.shapeId,
    field: "%dtype",
    type: F64,
    loc,
  };
  return {
    kind: "bin",
    op: "===",
    left: dtype,
    right: { kind: "numLit", value: code, type: F64, loc },
    type: BOOL,
    loc,
  };
}
