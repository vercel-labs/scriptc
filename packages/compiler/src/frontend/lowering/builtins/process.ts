import { keyedHelperName } from "../stable-names.js";
import { stdinKeypressListener } from "./readline.js";
import { envSnapshotHelper, lowerProcessLoadEnvFile } from "./environment.js";
import { dynUndefinedExpr, boolLit, numLit, strLit, varRef } from "../../../ir/build.js";
import { timerStyleCallback } from "../lower-timers.js";
import * as ts from "../../ts7/adapter.js";
import { requestGeneralStreamSurface } from "../general-streams.js";
import { type Lowerer, own } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { isSafeToDiscard } from "../expressions/evaluation-safety.js";
import { defaultAfterUndefined, lowerStaticallyUndefinedArgument } from "../optional-arguments.js";
import { voidizedCallback } from "../lower-server.js";
import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  PROCSTREAM_T,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
  arrayOf,
  canBoxFuncIntoDyn,
  funcOf,
} from "../../../ir/ir.js";
import { lowerBuiltinLoaderValue } from "../lower-builtin-values.js";
import { builtinFunctionValue } from "../lower-exprs.js";
import { canonicalBuiltinModule } from "../../builtin-modules.js";
import { lowerProcessIpcSend, ipcMessageListener, ipcDisconnectListener } from "./ipc.js";
import { lowerDiagnosticsSubscriber, lowerTracingArguments } from "./async-context.js";

/** Whether the process has an IPC channel, Node's test for defining
 * process.send and process.disconnect: a channel this fork child opened
 * (programs with fork targets only), or a non-empty NODE_CHANNEL_FD from a
 * Node.js parent, the variable Node itself tests at startup. Built from the
 * existing environment read, so the presence test links no runtime code. */
export function processHasIpc(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const envT = lowerer.envValueType();
  const unionId = (envT as IrType & { kind: "union" }).unionId;
  const stringTag = lowerer.armTag(unionId, STRING);
  const value = lowerer.declareHiddenLocal("%channelFd", envT);
  const fromNode: IrExpr = {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: value.id,
        init: {
          kind: "libCall",
          fn: "process.envGet",
          args: [strLit("NODE_CHANNEL_FD", loc)],
          type: envT,
          loc,
        },
        loc,
      },
    ],
    result: {
      kind: "logical",
      op: "&&",
      left: {
        kind: "unionIsTag",
        unionId,
        tag: stringTag,
        negated: false,
        value: varRef(value.id, envT, loc),
        type: BOOL,
        loc,
      },
      right: {
        kind: "toBool",
        operand: {
          kind: "unionNarrow",
          unionId,
          tag: stringTag,
          value: varRef(value.id, envT, loc),
          type: STRING,
          loc,
        },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
  if (lowerer.forkTargets.length === 0) return fromNode;
  return {
    kind: "logical",
    op: "||",
    left: { kind: "libCall", fn: "process.ipcOpen", args: [], type: BOOL, loc },
    right: fromNode,
    type: BOOL,
    loc,
  };
}

/** True when the value of `node` is consumed only by ToBoolean: a
 * condition, the operand of `!`, `Boolean(node)`, or an operand of `&&` /
 * `||` whose own value is consumed that way (or discarded, for the left
 * operand). */
export function isTruthinessOnlyRead(lowerer: Lowerer, node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined) return false;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
    return parent.expression === child;
  if (ts.isForStatement(parent)) return parent.condition === child;
  if (ts.isConditionalExpression(parent)) return parent.condition === child;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isCallExpression(parent)) {
    return (
      !parent.questionDotToken &&
      parent.arguments.nodes.length === 1 &&
      parent.arguments.nodes[0] === child &&
      lowerer.isStdlibGlobal(parent.expression, "Boolean")
    );
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (op !== ts.SyntaxKind.AmpersandAmpersandToken && op !== ts.SyntaxKind.BarBarToken)
      return false;
    if (isTruthinessOnlyRead(lowerer, parent)) return true;
    let outer: ts.Node | undefined = parent.parent;
    while (outer !== undefined && ts.isParenthesizedExpression(outer)) outer = outer.parent;
    return parent.left === child && outer !== undefined && ts.isExpressionStatement(outer);
  }
  return false;
}

/** Whether a program source reads process.exitCode. Such a program
 * records its exit-code assignments (process.setExitCodeTracked), so a
 * read can tell an unset code from 0; other programs keep the untracked
 * write. Computed once per lowering pass. */
export function programReadsExitCode(lowerer: Lowerer): boolean {
  if (lowerer.readsExitCode !== null) return lowerer.readsExitCode;
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "exitCode" &&
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) &&
      lowerer.stdlibGlobalMember(node, "process") === "exitCode"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    walk(sf);
    if (found) break;
  }
  lowerer.readsExitCode = found;
  return found;
}

/** The pinned Node release the runtime reports as process.versions.node
 * (packages/runtime/src/scr_lib.c SCR_NODE_COMPAT_VERSION, kept equal to
 * internal/compatibility/node-v24.json by test/node-pin.test.ts). */
export const NODE_COMPAT_VERSION = "24.22.0";

/** Method calls on first-class process-stream receivers (procStream —
 * a WritableStream-typed value like prefixStream's `output` param):
 * write(data) with one string and terminal geometry, dispatched onto
 * the original stdout/stderr descriptor. Other declared stream members
 * retain member-qualified diagnostics.
 * Null for non-procStream receivers. */
export function lowerProcStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "procStream") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (isJsSourceFile(ts.getSourceFileOfNode(call))) {
    const receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind === "dyn") {
      return {
        kind: "dynInvoke",
        recv: receiver,
        method: name,
        calleeName: ts.getTextOfNode(call.expression),
        args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      };
    }
  }
  if (name === "getWindowSize" && call.arguments.nodes.length === 0) {
    const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(access.expression), DYN);
    return lowerer.coerceInto(
      call,
      {
        kind: "dynInvoke",
        recv: receiver,
        method: name,
        calleeName: ts.getTextOfNode(call.expression),
        args: [],
        type: DYN,
        loc,
      },
      lowerer.irTypeOf(call),
    );
  }
  if (name === "write" && call.arguments.nodes.length === 1) {
    const receiver = lowerer.lowerExpr(access.expression);
    const data = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (data.type.kind !== "string") {
      requestGeneralStreamSurface(lowerer, access.expression);
      lowerer.noLowering(
        `write of '${lowerer.fmt(data.type)}' data on a stream value`,
        call.arguments.nodes[0]!,
        "one string is the supported form here — narrow unions first",
      );
    }
    return { kind: "libCall", fn: "procStream.write", args: [receiver, data], type: BOOL, loc };
  }
  requestGeneralStreamSurface(lowerer, access.expression);
  lowerer.noLowering(
    `WritableStream.${name}`,
    call,
    "write(data) with one string and getWindowSize() are the supported stream-value methods",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Standard streams expose optional terminal properties: pipes have no
 * isTTY, columns, or rows. The declarations do not prove their presence. */
export function isOptionalProcessStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  if (!["isTTY", "columns", "rows"].includes(expr.name.text)) return false;
  let recv = expr.expression;
  while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isTypeAssertion(recv))
    recv = recv.expression;
  if (ts.isPropertyAccessExpression(recv)) {
    const stream = lowerer.stdlibGlobalMember(recv, "process");
    if (
      stream === "stdout" ||
      stream === "stderr" ||
      (stream === "stdin" && expr.name.text === "isTTY")
    )
      return true;
  }
  return lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "procStream";
}

/** The process.versions entries @types/node declares as plain strings
 * that the runtime's versions object (node and openssl only) lacks. */
const ABSENT_DECLARED_VERSIONS: ReadonlySet<string> = new Set([
  "http_parser",
  "v8",
  "ares",
  "uv",
  "zlib",
  "modules",
]);

/** A process.versions member read whose declaration promises a string the
 * runtime does not have. @types/node declares the entries above as plain
 * strings, so a checked string read would throw on the absent entry and
 * equality with undefined would fold to false. These reads keep the
 * undefined arm, like the optional stream properties. The shipped fallback
 * types declare other entries `string | undefined` and never reach this.
 * An element read with a computed key qualifies when the checker types it
 * as a plain string. */
export function isOptionalProcessVersionsRead(lowerer: Lowerer, node: ts.Node): boolean {
  let key: string | null;
  if (ts.isPropertyAccessExpression(node)) key = node.name.text;
  else if (ts.isElementAccessExpression(node))
    key = ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
  else return false;
  if (key !== null && !ABSENT_DECLARED_VERSIONS.has(key)) return false;
  if (!programMentionsVersions(lowerer)) return false;
  const symbol = lowerer.typeOf(node.expression).getSymbol();
  return (
    symbol !== undefined &&
    ts.symbolName(symbol) === "ProcessVersions" &&
    symbol.declarations.some(
      (d) => ts.isInterfaceDeclaration(d) && lowerer.isStdlibFile(d.getSourceFile()),
    ) &&
    lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "string"
  );
}

/** Whether any implementation source spells `versions`. Programs that
 * never do skip the per-read checker queries above entirely. */
function programMentionsVersions(lowerer: Lowerer): boolean {
  lowerer.mentionsProcessVersions ??= lowerer.program
    .getImplementationSourceFiles()
    .some((sf) => !sf.isDeclarationFile && sf.text.includes("versions"));
  return lowerer.mentionsProcessVersions;
}

export function lowerProcessStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const member = expr.name.text;
  const direct = ts.isPropertyAccessExpression(expr.expression)
    ? lowerer.stdlibGlobalMember(expr.expression, "process")
    : null;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    (direct === "stdin" ||
      direct === "stdout" ||
      direct === "stderr" ||
      lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "procStream")
  ) {
    const value = lowerer.lowerExpr(expr.expression);
    if (value.type.kind === "dyn")
      return {
        kind: "dynKeyGet",
        value,
        key: strLit(member, locOf(expr.name)),
        type: DYN,
        loc: locOf(expr),
      };
  }
  // `if (process.stdin.setRawMode)`: Node's stdin has the method only
  // when it is a TTY. The runtime's stream object answers the same
  // presence (the method or undefined); calls keep their direct lowering.
  if (direct === "stdin" && member === "setRawMode") {
    return {
      kind: "dynKeyGet",
      value: lowerer.lowerExpr(expr.expression),
      key: strLit(member, locOf(expr.name)),
      type: DYN,
      loc: locOf(expr),
    };
  }
  if (member !== "isTTY" && member !== "columns" && member !== "rows") return null;
  let recv: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isTypeAssertion(recv))
    recv = recv.expression;
  // Browser-compatible packages commonly write
  // `(process.stdout || {}).isTTY`. Node's stream object is always
  // present and truthy, so the fallback cannot run; match the left
  // receiver exactly as the value-level always-truthy `||` lowering
  // does, preserving the native isatty/columns answer.
  if (ts.isBinaryExpression(recv) && recv.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    let left = recv.left;
    while (
      ts.isParenthesizedExpression(left) ||
      ts.isAsExpression(left) ||
      ts.isTypeAssertion(left)
    )
      left = left.expression;
    if (ts.isPropertyAccessExpression(left)) recv = left;
  }
  if (
    lowerer.mapTypeOf(lowerer.typeOf(recv))?.kind === "procStream" &&
    !(
      ts.isPropertyAccessExpression(recv) &&
      ["stdout", "stderr"].includes(lowerer.stdlibGlobalMember(recv, "process") ?? "")
    )
  ) {
    const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(expr.expression), DYN);
    return lowerer.coerceToExpected(
      {
        kind: "dynKeyGet",
        value: receiver,
        key: strLit(member, locOf(expr)),
        type: DYN,
        loc: locOf(expr),
      },
      lowerer.withUndefinedArm(member === "isTTY" ? BOOL : F64),
    );
  }
  if (!ts.isPropertyAccessExpression(recv)) return null;
  const stream = lowerer.stdlibGlobalMember(recv, "process");
  if (stream !== "stdin" && stream !== "stdout" && stream !== "stderr") return null;
  const loc = locOf(expr);
  const fd: IrExpr = {
    kind: "numLit",
    value: stream === "stdin" ? 0 : stream === "stdout" ? 1 : 2,
    type: F64,
    loc,
  };
  if (member === "isTTY") {
    const type = lowerer.withUndefinedArm(BOOL);
    return {
      kind: "ternary",
      cond: { kind: "libCall", fn: "process.isTTY", args: [fd], type: BOOL, loc },
      then: lowerer.coerceToExpected(boolLit(true, loc), type),
      else_: lowerer.coerceToExpected(
        { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type,
      ),
      type,
      loc,
    };
  }
  if (stream === "stdin") return null;
  const want = lowerer.withUndefinedArm(F64);
  return {
    kind: "libCall",
    fn: member === "rows" ? "process.rows" : "process.columns",
    args: [fd],
    type: want,
    loc,
  };
}

/** `process.argv` / `process.platform` / `process.pid` property READS
 * lower to zero-arg libCalls (argv returns +1 on one interned array —
 * identity and mutation semantics match Node's stable process.argv).
 * `process.env` as a WHOLE value lowers to a fresh SNAPSHOT record —
 * `{ [k: string]: string | undefined }` built over environ by the
 * interned %env.snapshot helper: `{ ...process.env }`, Object.keys, and
 * spawn-env flows all snapshot at the read, exactly what Node's own
 * spread does (and nothing in a compiled program mutates environ between
 * a snapshot and its use except process.env writes, which precede the
 * read in source order). Method members referenced without a call are
 * rejected specifically. Null for non-process receivers (the chain keeps
 * trying other property lowerings). */
/** The value of a DATA member of the process global taken off by
 * destructuring (`const { env, argv } = process` in JavaScript, the
 * supports-color opening): the same values the spelled `process.env` /
 * `process.argv` reads produce, typed by the binding. Null for members
 * this does not cover (methods keep the destructuring fence). */
export function processDataMemberValue(
  lowerer: Lowerer,
  member: string,
  binding: ts.Node,
  loc: SrcLoc,
): IrExpr | null {
  switch (member) {
    case "env": {
      const mapped = lowerer.mapTypeOf(lowerer.typeOf(binding));
      if (mapped?.kind !== "record") return null;
      const helper = envSnapshotHelper(lowerer, mapped.shapeId, loc);
      return helper === null ? null : { kind: "call", callee: helper, args: [], type: mapped, loc };
    }
    case "argv":
      return { kind: "libCall", fn: "process.argv", args: [], type: arrayOf(STRING), loc };
    case "platform":
      return { kind: "libCall", fn: "process.platform", args: [], type: STRING, loc };
    case "arch":
      return { kind: "libCall", fn: "process.arch", args: [], type: STRING, loc };
    case "pid":
      return { kind: "libCall", fn: "process.pid", args: [], type: F64, loc };
    case "execPath":
      return { kind: "libCall", fn: "process.execPath", args: [], type: STRING, loc };
    case "versions":
      return { kind: "libCall", fn: "process.versions", args: [], type: DYN, loc };
    default:
      return null;
  }
}

export function lowerProcessProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (
    !expr.questionDotToken &&
    expr.name.text === "bigint" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "process") === "hrtime"
  ) {
    const loc = locOf(expr);
    return {
      kind: "dynKeyGet",
      value: { kind: "libCall", fn: "process.hrtimeValue", args: [], type: DYN, loc },
      key: { kind: "strLit", value: "bigint", type: STRING, loc },
      type: DYN,
      loc,
    };
  }
  // node and openssl name the compatibility target, not linked engines.
  // Read the stable object so descriptor edits through aliases stay visible.
  if (
    (expr.name.text === "node" || expr.name.text === "openssl") &&
    !expr.questionDotToken &&
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "process") === "versions"
  ) {
    // versions.openssl answers the compat target's string for the same
    // reason versions.node does: Boolean(versions.openssl) is Node's own
    // "is crypto available" probe, and the crypto module exists here
    // (unsupported members fence per site). SEMANTICS.md documents that
    // the string names the compat target, not a linked library.
    const loc = locOf(expr);
    return lowerer.coerceToExpected(
      {
        kind: "dynKeyGet",
        key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
        value: { kind: "libCall", fn: "process.versions", args: [], type: DYN, loc },
        type: DYN,
        loc,
      },
      STRING,
    );
  }
  // Other components begin absent. Consult the same object even for the
  // capability probes: users can define or delete their own entries.
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    lowerer.stdlibGlobalMember(expr.expression, "process") === "versions"
  ) {
    const loc = locOf(expr);
    return {
      kind: "dynKeyGet",
      key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
      value: { kind: "libCall", fn: "process.versions", args: [], type: DYN, loc },
      type: DYN,
      loc,
    };
  }
  // The capability-probe members that honestly DON'T EXIST in a
  // compiled binary — each reads undefined (their declared types carry
  // the undefined arm), so feature probes take their documented
  // fallbacks: no gyp build config (process.config.variables.* — no ICU,
  // no QUIC — and process.config.target_defaults), no feature flags
  // (process.features.* — no inspector, not a debug build).
  if (!expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
    const container = lowerer.stdlibGlobalMember(expr.expression, "process");
    if (container === "features") {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
    }
    if (
      container === "config" &&
      (expr.name.text === "variables" || expr.name.text === "target_defaults")
    ) {
      // `target_defaults` reads undefined directly. `variables` only
      // appears as the receiver of a member read — that OUTER access is
      // the undefined answer (below); a bare `variables` value fences.
      if (expr.name.text === "target_defaults") {
        return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
      }
    }
    // process.config.variables.<name> — the full chain.
    if (
      ts.isPropertyAccessExpression(expr.expression.expression) &&
      expr.expression.name.text === "variables" &&
      lowerer.stdlibGlobalMember(expr.expression.expression, "process") === "config"
    ) {
      return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc: locOf(expr) };
    }
  }
  const member = lowerer.stdlibGlobalMember(expr, "process");
  if (member === null) return null;
  const loc = locOf(expr);
  // `if (process.send)`: Node defines process.send and process.disconnect
  // only when the process has an IPC channel. A read whose value only
  // feeds a truthiness test answers that presence; other value uses keep
  // the member fence.
  if (
    (member === "send" || member === "disconnect") &&
    !expr.questionDotToken &&
    isTruthinessOnlyRead(lowerer, expr)
  ) {
    return processHasIpc(lowerer, loc);
  }
  if (member === "versions") {
    return { kind: "libCall", fn: "process.versions", args: [], type: DYN, loc };
  }
  // process.exitCode: undefined until something assigns it, then the
  // assigned code. A read the checker narrowed to number follows an
  // assignment, so the code is set.
  if (member === "exitCode" && !expr.questionDotToken) {
    const current: IrExpr = {
      kind: "libCall",
      fn: "process.currentExitCode",
      args: [],
      type: F64,
      loc,
    };
    if (lowerer.mapTypeOf(lowerer.typeOf(expr))?.kind === "f64") return current;
    const type: IrType = { kind: "union", unionId: lowerer.unions.intern([F64, UNDEFINED_T]) };
    return {
      kind: "ternary",
      cond: { kind: "libCall", fn: "process.hasExitCode", args: [], type: BOOL, loc },
      then: lowerer.coerceToExpected(current, type),
      else_: lowerer.coerceToExpected(
        { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
        type,
      ),
      type,
      loc,
    };
  }
  // process.features as a value (`"sea" in process.features`): an object
  // holding none of the flags, consistent with the member reads above.
  if (member === "features") {
    return { kind: "dynObjLit", type: DYN, loc };
  }
  // process.noDeprecation / process.throwDeprecation: the values the
  // program assigned (undefined before that — no Node flags reach a
  // compiled binary).
  if (member === "noDeprecation" || member === "throwDeprecation") {
    return {
      kind: "libCall",
      fn: "process.deprecationFlag",
      args: [numLit(member === "noDeprecation" ? 0 : 1, loc)],
      type: DYN,
      loc,
    };
  }
  if (member === "version") {
    // Node's own version string for the compatibility target, the same
    // release process.versions.node names (the runtime's
    // SCR_NODE_COMPAT_VERSION) with Node's leading "v".
    return strLit(`v${NODE_COMPAT_VERSION}`, loc);
  }
  if (member === "hrtime") {
    return { kind: "libCall", fn: "process.hrtimeValue", args: [], type: DYN, loc };
  }
  // A stored process.nextTick in JavaScript (`cond ? setImmediate :
  // process.nextTick`): the interned builtin function value.
  if (member === "nextTick" && isJsSourceFile(ts.getSourceFileOfNode(expr))) {
    return builtinFunctionValue("process.nextTick", loc);
  }
  if (member === "getBuiltinModule") {
    // Keep the native loader's argument validation when the function is
    // stored. The declaration's string signature must not insert a checked
    // adapter before the loader gets to report Node's invalid-id error.
    return { kind: "dynFrom", value: lowerBuiltinLoaderValue(lowerer, loc), type: DYN, loc };
  }
  if (member === "argv") {
    return { kind: "libCall", fn: "process.argv", args: [], type: arrayOf(STRING), loc };
  }
  if (member === "connected") {
    return { kind: "libCall", fn: "process.connected", args: [], type: BOOL, loc };
  }
  // process.execArgv: the Node runtime flags kept out of process.argv —
  // a leading --test-update-snapshots in node:test programs, else [].
  if (member === "execArgv") {
    return { kind: "libCall", fn: "process.execArgv", args: [], type: arrayOf(STRING), loc };
  }
  // process._exiting — the runtime's exit-sequence flag (true while
  // 'exit' listeners run), Node's own undocumented member.
  if (member === "_exiting") {
    return { kind: "libCall", fn: "process.exiting", args: [], type: BOOL, loc };
  }
  if (member === "platform") {
    return { kind: "libCall", fn: "process.platform", args: [], type: STRING, loc };
  }
  // process.arch: the compiled binary's OWN architecture ("arm64",
  // "x64") — the same answer Node gives for its own build on the same
  // machine.
  if (member === "arch") {
    return { kind: "libCall", fn: "process.arch", args: [], type: STRING, loc };
  }
  if (member === "pid") {
    return { kind: "libCall", fn: "process.pid", args: [], type: F64, loc };
  }
  if (member === "ppid") {
    return { kind: "libCall", fn: "process.ppid", args: [], type: F64, loc };
  }
  // process.title: libuv's process title — argv[0] until a write
  // (lower-stmts' process.title assignment) replaces it.
  if (member === "title") {
    return { kind: "libCall", fn: "process.title", args: [], type: STRING, loc };
  }
  if (member === "argv0") {
    return { kind: "libCall", fn: "process.argv0", args: [], type: STRING, loc };
  }
  // process.release: the compatibility target's release record, one
  // stable object like Node's.
  if (member === "release") {
    return { kind: "libCall", fn: "process.release", args: [], type: DYN, loc };
  }
  // process.execPath: the compiled binary's own resolved absolute path —
  // the honest answer where Node's is the node executable's (SEMANTICS.md
  // divergence 12, the argv[0]/argv[1] precedent).
  if (member === "execPath") {
    return { kind: "libCall", fn: "process.execPath", args: [], type: STRING, loc };
  }
  if (member === "env") {
    const mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    if (mapped?.kind === "record") {
      const helper = envSnapshotHelper(lowerer, mapped.shapeId, loc);
      if (helper !== null) {
        return { kind: "call", callee: helper, args: [], type: mapped, loc };
      }
    }
    lowerer.unsupported(
      "SC1090",
      expr,
      "process.env as a value of this type (read one variable: process.env.NAME or process.env[name])",
    );
  }
  if (member === "exit" || member === "cwd" || member === "getuid" || member === "kill") {
    lowerer.unsupported("SC1090", expr, `process methods as values (call '${member}' directly)`);
  }
  // process.stdout / process.stderr as first-class VALUES (flowing into
  // a `NodeJS.WritableStream` slot — the prefixStream idiom): the
  // procStream scalar, minted as the stream's fd. Member reads
  // (`process.stdout.isTTY`, `.write(...)`) never reach here — their
  // OUTER expressions dispatch first.
  if (
    member === "stdin" ||
    ((member === "stdout" || member === "stderr") && isJsSourceFile(ts.getSourceFileOfNode(expr)))
  ) {
    return {
      kind: "libCall",
      fn: "process.stdio",
      args: [numLit(member === "stdin" ? 0 : member === "stdout" ? 1 : 2, loc)],
      type: DYN,
      loc,
    };
  }
  if (member === "stdout" || member === "stderr") {
    return { kind: "numLit", value: member === "stdout" ? 1 : 2, type: PROCSTREAM_T, loc };
  }
  // Other members: type errors under the fallback declarations; with
  // @types/node they typecheck and fall through to stdlibMemberFence
  // (SC2020 naming process.<member>, with the console.log hint for
  // stdout/stderr).
  return null;
}

/** `process.exit(code)` / `process.cwd()` → libCall. The fallback
 * declaration makes exit's code required; @types/node declares it
 * optional. A bare `process.exit()` uses the current exitCode, or zero
 * when unset. */
export function lowerProcessMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken) return null;
  if (
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    ts.isPropertyAccessExpression(access.expression)
  ) {
    const stream = lowerer.stdlibGlobalMember(access.expression, "process");
    if (stream === "stdin" || stream === "stdout" || stream === "stderr") {
      if (call.arguments.nodes.some(ts.isSpreadElement))
        lowerer.noLowering("process stream spread arguments", call);
      return {
        kind: "dynInvoke",
        recv: lowerer.lowerExpr(access.expression),
        method: access.name.text,
        calleeName: ts.getTextOfNode(access),
        args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc: locOf(call),
      };
    }
  }
  const directProcessMember = lowerer.stdlibGlobalMember(access, "process");
  if (directProcessMember === "loadEnvFile") return lowerProcessLoadEnvFile(lowerer, call);
  if (directProcessMember === "hrtime") {
    if (call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("process.hrtime with spread arguments", call);
    const loc = locOf(call);
    return {
      kind: "dynCall",
      callee: { kind: "libCall", fn: "process.hrtimeValue", args: [], type: DYN, loc },
      args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
      calleeName: "process.hrtime",
      type: DYN,
      loc,
    };
  }
  if (directProcessMember === "getBuiltinModule") {
    if (call.arguments.nodes.some(ts.isSpreadElement))
      lowerer.noLowering("process.getBuiltinModule with spread arguments", call);
    const loc = locOf(call);
    const id = call.arguments.nodes[0]
      ? lowerer.lowerExprExpecting(call.arguments.nodes[0], DYN)
      : (dynUndefinedExpr(loc) satisfies IrExpr);
    const binding = lowerer.declareHiddenLocal("%builtinId", DYN);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: binding.id, init: id, loc },
        ...call.arguments.nodes.slice(1).map((arg): IrStmt => ({
          kind: "exprStmt",
          expr: lowerer.lowerExpr(arg),
          loc: locOf(arg),
        })),
      ],
      result: {
        kind: "callValue",
        callee: lowerBuiltinLoaderValue(lowerer, loc),
        args: [varRef(binding.id, DYN, loc)],
        type: DYN,
        loc,
      },
      type: DYN,
      loc,
    };
  }
  if (directProcessMember === "send") return lowerProcessIpcSend(lowerer, call);
  if (directProcessMember === "disconnect") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`process.disconnect with ${call.arguments.nodes.length} arguments`, call);
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "using the result of process.disconnect() (call it as its own statement)",
      );
    }
    return { kind: "libCall", fn: "process.disconnect", args: [], type: VOID, loc: locOf(call) };
  }
  // process.stdout.write(s[, encoding][, callback]) and stderr's twin:
  // raw bytes, no newline or formatting. stdout shares console.log's
  // promptly-submitted stream, preserving source order. Node's boolean
  // is a backpressure signal; this synchronous write is constantly true.
  // String encodings are compile-time-known BufferEncoding spellings;
  // byte chunks evaluate but ignore the encoding like Node. Completion
  // callbacks ride the next-tick queue and receive the success `null`.
  // process.stdin.destroy(): a deliberate no-op — no stream machinery
  // exists to tear down, and no other stdin surface observes the
  // destroyed state (SEMANTICS.md documents it).
  if (
    access.name.text === "destroy" &&
    ts.isPropertyAccessExpression(access.expression) &&
    lowerer.stdlibGlobalMember(access.expression, "process") === "stdin"
  ) {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering("stdin.destroy with arguments", call);
    }
    return { kind: "libCall", fn: "process.stdinDestroy", args: [], type: VOID, loc: locOf(call) };
  }
  // process.stdin.setRawMode(mode): termios raw mode when stdin IS a
  // TTY (libuv's UV_TTY_MODE_RAW — the flag set Node applies; false
  // restores the entry state). When stdin is NOT a TTY, Node's
  // process.stdin is a Socket with no setRawMode member at all, so the
  // call throws Node's exact catchable TypeError — the portless
  // exit-hook wraps it in try/catch and relies on exactly that. Node
  // returns `this` for chaining; that composition has no lowering, so
  // statement position (or a concise arrow body) is required.
  if (
    access.name.text === "setRawMode" &&
    ts.isPropertyAccessExpression(access.expression) &&
    lowerer.stdlibGlobalMember(access.expression, "process") === "stdin"
  ) {
    const loc = locOf(call);
    if (!ts.isExpressionStatement(call.parent) && !ts.isArrowFunction(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "using the result of stdin.setRawMode(...) (the ReadStream chain — call it as its own statement)",
      );
    }
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(
        `stdin.setRawMode with ${call.arguments.nodes.length} arguments`,
        call,
        "the supported form is setRawMode(mode) with one boolean",
      );
    }
    const mode = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (mode.type.kind !== "bool") {
      lowerer.noLowering(
        `stdin.setRawMode of '${lowerer.fmt(mode.type)}' modes`,
        call.arguments.nodes[0]!,
        "the mode is a boolean here — narrow unions first",
      );
    }
    return { kind: "libCall", fn: "process.stdinSetRawMode", args: [mode], type: VOID, loc };
  }
  // process.stdout.on("resize", cb) (and once/off/removeListener/
  // addListener, stderr too): the terminal resize event, registered on the
  // runtime's process stream object (a SIGWINCH listener that emits when a
  // TTY's size changed; it never keeps the loop alive). Statement position:
  // Node returns the stream.
  if (
    ["on", "once", "off", "removeListener", "addListener"].includes(access.name.text) &&
    ts.isPropertyAccessExpression(access.expression) &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some(ts.isSpreadElement) &&
    ts.isExpressionStatement(call.parent)
  ) {
    const stream = lowerer.stdlibGlobalMember(access.expression, "process");
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    if (
      (stream === "stdout" || stream === "stderr") &&
      evT.isStringLiteralType() &&
      evT.value === "resize"
    ) {
      const loc = locOf(call);
      const receiverLocal = lowerer.declareHiddenLocal("%stdioReceiver", DYN);
      const receiver = varRef(receiverLocal.id, DYN, loc);
      const method =
        access.name.text === "off"
          ? "removeListener"
          : access.name.text === "addListener"
            ? "on"
            : access.name.text;
      return {
        kind: "seqExpr",
        stmts: [
          {
            kind: "varDecl",
            localId: receiverLocal.id,
            init: {
              kind: "libCall",
              fn: "process.stdio",
              args: [numLit(stream === "stdout" ? 1 : 2, loc)],
              type: DYN,
              loc,
            },
            loc,
          },
        ],
        result: {
          kind: "dynCall",
          callee: {
            kind: "dynKeyGet",
            value: receiver,
            key: strLit(method, locOf(access.name)),
            type: DYN,
            loc,
          },
          receiver,
          calleeName: ts.getTextOfNode(access),
          args: [
            lowerer.lowerExprExpecting(call.arguments.nodes[0]!, DYN),
            lowerer.lowerExprExpecting(call.arguments.nodes[1]!, DYN),
          ],
          type: DYN,
          loc,
        },
        type: DYN,
        loc,
      };
    }
  }
  // process.stdin.on/once("data" | "end" | "error", cb): the piped-stdin
  // event slice. A 'data' listener keeps the event loop alive until EOF
  // (Node's flowing stdin); 'end'/'error' listeners alone do not. `once`
  // auto-removes after the first delivery. Listener shapes are pinned
  // per event — the runtime adapters cover exactly these.
  if (
    (access.name.text === "on" || access.name.text === "once") &&
    ts.isPropertyAccessExpression(access.expression) &&
    lowerer.stdlibGlobalMember(access.expression, "process") === "stdin"
  ) {
    const loc = locOf(call);
    const once = access.name.text === "once";
    if (call.arguments.nodes.length !== 2) {
      lowerer.noLowering(
        `stdin.${access.name.text} with ${call.arguments.nodes.length} arguments`,
        call,
      );
    }
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event !== "data" && event !== "end" && event !== "error" && event !== "keypress") {
      lowerer.noLowering(
        `stdin.${access.name.text}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments.nodes[0]!,
        '"data", "end", "error", and "keypress" are the supported stdin events (as literals)',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining stdin listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    if (event === "keypress") {
      // readline.emitKeypressEvents' (str, key) events
      const listener = stdinKeypressListener(lowerer, call.arguments.nodes[1]!);
      const onceKp: IrExpr = { kind: "boolLit", value: once, type: BOOL, loc };
      return { kind: "libCall", fn: "stdin.onKeypress", args: [listener, onceKp], type: VOID, loc };
    }
    const cb = lowerer.lowerExpr(call.arguments.nodes[1]!);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        "stdin listeners with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    const onceArg: IrExpr = { kind: "boolLit", value: once, type: BOOL, loc };
    if (event === "data") {
      // A string parameter receives the chunks process.stdin.setEncoding
      // decodes (pi-tui's terminal input); the runtime refuses a delivery
      // while no encoding is set, where Node would pass a Buffer.
      if (
        param !== undefined &&
        !(param.kind === "bytes" && param.elem === "u8") &&
        param.kind !== "string"
      ) {
        lowerer.unsupported(
          "SC1090",
          call.arguments.nodes[1]!,
          `data listeners whose parameter is not 'Uint8Array' or 'string' (got '${lowerer.fmt(param)}')`,
        );
      }
      return { kind: "libCall", fn: "stdin.onData", args: [cb, onceArg], type: VOID, loc };
    }
    if (event === "end") {
      if (param !== undefined) {
        lowerer.unsupported(
          "SC1090",
          call.arguments.nodes[1]!,
          "end listeners with parameters (use ())",
        );
      }
      return { kind: "libCall", fn: "stdin.onEnd", args: [cb, onceArg], type: VOID, loc };
    }
    if (param !== undefined && !(param.kind === "object" && param.className === "%Error")) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        `error listeners whose parameter is not 'Error' (got '${lowerer.fmt(param)}')`,
      );
    }
    return { kind: "libCall", fn: "stdin.onError", args: [cb, onceArg], type: VOID, loc };
  }
  if (access.name.text === "write" && ts.isPropertyAccessExpression(access.expression)) {
    const stream = lowerer.stdlibGlobalMember(access.expression, "process");
    if (stream === "stdout" || stream === "stderr") {
      const loc = locOf(call);
      const args = call.arguments.nodes;
      if (args.length < 1 || args.length > 3 || args.some(ts.isSpreadElement)) {
        lowerer.noLowering(
          `process.${stream}.write with ${args.length} arguments`,
          call,
          "the supported forms are write(data[, encoding][, callback]) with a static BufferEncoding and completion callback",
        );
      }
      const secondNode = args[1];
      const thirdNode = args[2];
      const secondUndefined = secondNode
        ? lowerStaticallyUndefinedArgument(lowerer, secondNode)
        : null;
      const thirdUndefined = thirdNode
        ? lowerStaticallyUndefinedArgument(lowerer, thirdNode)
        : null;
      const secondT =
        secondNode && !secondUndefined ? lowerer.mapTypeOf(lowerer.typeOf(secondNode)) : undefined;
      const callbackNode =
        args.length === 3 && !thirdUndefined
          ? thirdNode!
          : args.length === 2 && secondT?.kind === "func"
            ? secondNode!
            : undefined;
      const encodingNode =
        (args.length === 3 || (args.length === 2 && callbackNode === undefined)) && !secondUndefined
          ? secondNode!
          : undefined;

      // Node's BufferEncoding aliases normalize before bytes are made.
      // Preserve an effectful literal-typed expression even when its
      // spelling folds (for example a function returning `"binary"`).
      const encoding: IrExpr = ((): IrExpr => {
        const defaultEncoding = {
          kind: "strLit",
          value: "utf8",
          type: STRING,
          loc,
        } satisfies IrExpr;
        if (secondUndefined) {
          return defaultAfterUndefined(secondUndefined, defaultEncoding);
        }
        if (!encodingNode) {
          return defaultEncoding;
        }
        const aliases: Record<string, string | undefined> = {
          utf8: "utf8",
          "utf-8": "utf8",
          hex: "hex",
          base64: "base64",
          base64url: "base64url",
          latin1: "latin1",
          binary: "latin1",
          ascii: "ascii",
          utf16le: "utf16le",
          "utf-16le": "utf16le",
          ucs2: "utf16le",
          "ucs-2": "utf16le",
        };
        const t = lowerer.typeOf(encodingNode);
        const raw = t.isStringLiteralType() ? t.value : undefined;
        const canonical = raw !== undefined ? own(aliases, raw) : undefined;
        if (canonical === undefined) {
          lowerer.noLowering(
            `process.${stream}.write with this encoding`,
            encodingNode,
            'use a literal "utf8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", or "ucs2" encoding',
          );
        }
        const evaluated = lowerer.lowerExprExpecting(encodingNode, STRING);
        if (canonical === raw) return evaluated;
        const normalized: IrExpr = {
          kind: "strLit",
          value: canonical,
          type: STRING,
          loc: locOf(encodingNode),
        };
        return isSafeToDiscard(evaluated)
          ? normalized
          : {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: evaluated, loc: evaluated.loc }],
              result: normalized,
              type: STRING,
              loc: evaluated.loc,
            };
      })();

      let data = lowerer.lowerExpr(args[0]!);
      // A checked-dynamic argument in a JS file takes the validated
      // string exit (the trust-but-verify boundary: commander's
      // `writeOut: (str) => process.stdout.write(str)` — str untyped):
      // a runtime string writes; anything else throws the dynCheck's
      // honest TypeError at the call.
      if (data.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(call))) {
        data = { kind: "dynCheck", value: data, type: STRING, loc };
      }
      const isBytes = data.type.kind === "bytes" && data.type.elem === "u8";
      if (!isBytes && data.type.kind !== "string") {
        lowerer.noLowering(
          `process.${stream}.write of non-string data`,
          args[0]!,
          "strings and Buffer/Uint8Array values write; narrow unions first",
        );
      }

      let callback: IrExpr | undefined;
      if (callbackNode) {
        callback = lowerer.lowerExpr(callbackNode);
        if (callback.type.kind === "dyn" && isJsSourceFile(ts.getSourceFileOfNode(call))) {
          callback = {
            kind: "dynCheck",
            value: callback,
            type: funcOf([DYN], VOID),
            loc: locOf(callbackNode),
          };
        }
        let callbackOk = callback.type.kind === "func" && callback.type.params.length <= 1;
        if (callbackOk && callback.type.kind === "func" && callback.type.params.length === 1) {
          const param = callback.type.params[0]!;
          if (param.kind !== "dyn") {
            const def = param.kind === "union" ? lowerer.unions.get(param.unionId) : undefined;
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
          }
        }
        if (!callbackOk) {
          lowerer.unsupported(
            "SC1090",
            callbackNode,
            "process output completion callbacks must accept at most one Error | null parameter",
          );
        }
        callback = voidizedCallback(lowerer, callback, locOf(callbackNode));
      }

      // Encoding- or callback-bearing writes use one fixed byte ABI. For
      // strings, Buffer.from's encoder runs after data/encoding evaluation
      // and before the callback expression; only its pure allocation moves
      // earlier than Node's internal write conversion.
      if (callback || args.length > 1 || isBytes) {
        const bytes = isBytes
          ? data
          : ({
              kind: "libCall",
              fn: "buffer.fromStr",
              args: [data, encoding],
              type: BYTES_U8,
              loc,
            } satisfies IrExpr);
        const defaultRuntimeEncoding = {
          kind: "strLit",
          value: "utf8",
          type: STRING,
          loc,
        } satisfies IrExpr;
        let runtimeEncoding = isBytes ? encoding : defaultRuntimeEncoding;
        // An explicitly-undefined third argument is still evaluated after
        // data and encoding, even though it schedules no callback. Strings
        // already evaluate encoding while producing `bytes`; byte chunks
        // fold both ignored argument effects into this final ABI slot.
        if (thirdUndefined && !isSafeToDiscard(thirdUndefined)) {
          const effects = isBytes
            ? [encoding, thirdUndefined].filter((effect) => !isSafeToDiscard(effect))
            : [thirdUndefined];
          runtimeEncoding = {
            kind: "seqExpr",
            stmts: effects.map((effect) => ({ kind: "exprStmt", expr: effect, loc: effect.loc })),
            result: defaultRuntimeEncoding,
            type: STRING,
            loc: thirdUndefined.loc,
          };
        }
        if (callback) {
          return {
            kind: "libCall",
            fn: stream === "stdout" ? "process.stdoutWriteBytesCb" : "process.stderrWriteBytesCb",
            args: [bytes, runtimeEncoding, callback],
            type: BOOL,
            loc,
          };
        }
        return {
          kind: "libCall",
          fn: stream === "stdout" ? "process.stdoutWriteBytes" : "process.stderrWriteBytes",
          args: [bytes, runtimeEncoding],
          type: BOOL,
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: stream === "stdout" ? "process.stdoutWrite" : "process.stderrWrite",
        args: [data],
        type: BOOL,
        loc,
      };
    }
  }
  // process.memoryUsage.rss(): the resident set alone, read on demand.
  if (
    access.name.text === "rss" &&
    !access.questionDotToken &&
    ts.isPropertyAccessExpression(access.expression) &&
    lowerer.stdlibGlobalMember(access.expression, "process") === "memoryUsage"
  ) {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(
        `process.memoryUsage.rss with ${call.arguments.nodes.length} arguments`,
        call,
      );
    }
    return { kind: "libCall", fn: "process.rss", args: [], type: F64, loc: locOf(call) };
  }
  const member = lowerer.stdlibGlobalMember(access, "process");
  if (member === null) return null;
  const loc = locOf(call);
  // process.on/once/off: the CLI event slice — named OS
  // signal handlers and the 'exit' hook. Signal listeners run as
  // macrotasks at loop turns, replace the default disposition while
  // registered (removing the last restores Ctrl-C death), and never
  // keep the loop alive; 'exit' listeners run synchronously at
  // termination (normal exit, process.exit, the exit-1 paths) with the
  // exit code. `once` auto-removes; `off` removes by identity (bind
  // the listener to a const so both sites see the same value), and
  // `removeListener` IS `off` — Node aliases them.
  const isOff = member === "off" || member === "removeListener";
  if (member === "on" || member === "once" || isOff) {
    if (call.arguments.nodes.length !== 2) {
      lowerer.noLowering(`process.${member} with ${call.arguments.nodes.length} arguments`, call);
    }
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if ((event === "message" || event === "disconnect") && !isOff) {
      if (!ts.isExpressionStatement(call.parent)) {
        lowerer.unsupported(
          "SC1090",
          call,
          "chaining process IPC listener registration (register each listener as its own statement)",
        );
      }
      const callback =
        event === "message"
          ? ipcMessageListener(lowerer, call.arguments.nodes[1]!)
          : ipcDisconnectListener(lowerer, call.arguments.nodes[1]!);
      return {
        kind: "libCall",
        fn: event === "message" ? "process.onMessage" : "process.onDisconnect",
        args: [callback, boolLit(member === "once", loc)],
        type: VOID,
        loc,
      };
    }
    if (event === "uncaughtException" || event === "uncaughtExceptionMonitor") {
      if (!ts.isExpressionStatement(call.parent)) {
        lowerer.unsupported("SC1090", call, "chaining process exception listener registration");
      }
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
      const monitor = boolLit(event === "uncaughtExceptionMonitor", loc);
      return {
        kind: "libCall",
        fn: isOff ? "process.offUncaughtException" : "process.onUncaughtException",
        args: isOff ? [cb, monitor] : [cb, boolLit(member === "once", loc), monitor],
        type: VOID,
        loc,
      };
    }
    // 'unhandledRejection': the listener crosses as a dyn function and
    // the completed-checkpoint report dispatches it (reason, promise) per
    // never-observed rejection instead of printing and exiting 1
    // (scr_async.c). `once` auto-removes after one delivery and
    // `off`/`removeListener` remove by closure identity — the warning
    // registry's story. 'rejectionHandled' is the sibling registry:
    // a handler attached after delivery fires it once, synchronously
    // with the promise.
    if (event === "unhandledRejection" || event === "rejectionHandled") {
      if (!ts.isExpressionStatement(call.parent)) {
        lowerer.unsupported(
          "SC1090",
          call,
          "chaining process listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
      const onceArg: IrExpr = { kind: "boolLit", value: member === "once", type: BOOL, loc };
      const fn: IrLibFn =
        event === "unhandledRejection"
          ? isOff
            ? "process.offUnhandledRejection"
            : "process.onUnhandledRejection"
          : isOff
            ? "process.offRejectionHandled"
            : "process.onRejectionHandled";
      return { kind: "libCall", fn, args: isOff ? [cb] : [cb, onceArg], type: VOID, loc };
    }
    // 'warning': the listener crosses as a dyn function; emitWarning and
    // util.deprecate dispatch on the next tick. off/removeListener remove
    // by closure identity.
    if (event === "warning" && (member === "on" || isOff)) {
      if (!ts.isExpressionStatement(call.parent)) {
        lowerer.unsupported(
          "SC1090",
          call,
          "chaining process listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
      return {
        kind: "libCall",
        fn: isOff ? "process.offWarning" : "process.onWarning",
        args: [cb],
        type: VOID,
        loc,
      };
    }
    if (event === null || event.startsWith("SIG")) {
      if (!ts.isExpressionStatement(call.parent)) {
        lowerer.unsupported("SC1090", call, "chaining process signal listener registration");
      }
      const name = lowerer.coerceToExpected(lowerer.lowerExpr(call.arguments.nodes[0]!), STRING);
      if (name.type.kind !== "string" && name.type.kind !== "dyn") {
        lowerer.noLowering(
          "process signal event name that is not a string",
          call.arguments.nodes[0]!,
        );
      }
      const signal =
        name.type.kind === "string"
          ? name
          : { kind: "dynCheck" as const, value: name, type: STRING, loc };
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
      return {
        kind: "libCall",
        fn: isOff ? "process.offSignal" : "process.onSignal",
        args: isOff ? [signal, cb] : [signal, cb, boolLit(member === "once", loc)],
        type: VOID,
        loc,
      };
    }
    if (event !== "exit") {
      lowerer.noLowering(`process.${member}("${event}", ...)`, call.arguments.nodes[0]!);
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining process listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    let cb = lowerer.lowerExpr(call.arguments.nodes[1]!);
    // The checked-dynamic listener (test/common's `process.on('exit',
    // runCallChecks)` — an implicit-any JS function, func(dyn)=>dyn, or
    // a dyn VALUE that rode an untyped binding): adapt through the dyn
    // function boundary to the registry's exact shape — box (dynFrom)
    // when needed, then dynCheck into (number)=>void / ()=>void. The
    // adapter delivers the exit code as a dyn argument and releases the
    // result; a non-function dyn value throws the catchable TypeError
    // at REGISTRATION (Node's ERR_INVALID_ARG_TYPE moment).
    {
      const target = funcOf([F64], VOID);
      const exact =
        cb.type.kind === "func" &&
        cb.type.ret.kind === "void" &&
        cb.type.params.length <= 1 &&
        (cb.type.params[0] === undefined || cb.type.params[0].kind === "f64");
      if (!exact) {
        if (cb.type.kind === "dyn") {
          cb = { kind: "dynCheck", value: cb, type: target, loc };
        } else if (
          cb.type.kind === "func" &&
          canBoxFuncIntoDyn(
            cb.type,
            (id) => lowerer.shapes.get(id),
            (id) => lowerer.unions.get(id),
          )
        ) {
          cb = {
            kind: "dynCheck",
            value: { kind: "dynFrom", value: cb, type: DYN, loc },
            type: target,
            loc,
          };
        }
      }
    }
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        "process listeners with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    const onceArg: IrExpr = { kind: "boolLit", value: member === "once", type: BOOL, loc };
    if (param !== undefined && param.kind !== "f64") {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        `exit listeners whose parameter is not 'number' (got '${lowerer.fmt(param)}')`,
      );
    }
    if (isOff) {
      return { kind: "libCall", fn: "process.offExit", args: [cb], type: VOID, loc };
    }
    return { kind: "libCall", fn: "process.onExit", args: [cb, onceArg], type: VOID, loc };
  }
  // process.emitWarning(...): the argument vector crosses as ONE dyn
  // array and the runtime applies Node's full grammar (string or Error
  // warning; type/ctor/options second; code/ctor third — wrong kinds
  // throw ERR_INVALID_ARG_TYPE). A single SPREAD of a checked-dynamic
  // array passes that array directly (the suite's forEach-spread
  // shape: `.forEach((args) => process.emitWarning(...args))`).
  if (member === "emitWarning") {
    let argsArr: IrExpr | null = null;
    if (call.arguments.nodes.length === 1 && ts.isSpreadElement(call.arguments.nodes[0]!)) {
      const spread = lowerer.lowerExpr(call.arguments.nodes[0]!.expression);
      if (spread.type.kind === "dyn") {
        argsArr = spread;
      } else {
        lowerer.noLowering(
          "process.emitWarning with a typed spread argument",
          call.arguments.nodes[0]!,
          "spread an untyped (checked-dynamic) array, or write the arguments positionally",
        );
      }
    } else {
      argsArr = lowerTracingArguments(lowerer, call.arguments.nodes, loc);
    }
    return { kind: "libCall", fn: "process.emitWarning", args: [argsArr], type: VOID, loc };
  }
  if (member === "cwd") {
    return { kind: "libCall", fn: "process.cwd", args: [], type: STRING, loc };
  }
  // process.nextTick(cb, ...args): the user tick queue — callbacks
  // drain before promise jobs at every loop checkpoint (Node's tick-
  // then-microtask order; the station-time divergence for ticks
  // scheduled by station listeners is SEMANTICS.md territory). The
  // callback adapts exactly like setImmediate's: zero-param passes
  // through, boxable parameterized shapes ride the checked-dynamic
  // boundary, trailing call arguments ride the interned dyn thunk.
  if (member === "nextTick") {
    if (call.arguments.nodes.length === 0) {
      lowerer.noLowering(
        "process.nextTick with 0 arguments",
        call,
        "the supported form is process.nextTick(callback, ...args)",
      );
    }
    const cb = timerStyleCallback(lowerer, call.arguments.nodes, "process.nextTick", loc);
    return { kind: "libCall", fn: "process.nextTick", args: [cb], type: VOID, loc };
  }
  // The process introspection statics — plain reads of the process's
  // own clocks and counters, Node's shapes exactly.
  if (member === "uptime" || member === "availableMemory" || member === "constrainedMemory") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`process.${member} with ${call.arguments.nodes.length} arguments`, call);
    }
    const fn =
      member === "uptime"
        ? "process.uptime"
        : member === "availableMemory"
          ? "process.availableMemory"
          : "process.constrainedMemory";
    return { kind: "libCall", fn, args: [], type: F64, loc };
  }
  // process.cpuUsage(prev?) / process.threadCpuUsage(prev?) — the
  // {user, system} microsecond records (getrusage / the thread clock).
  // The prev form validates Node-style (prevValue.user then .system,
  // the ERR_INVALID_ARG_VALUE RangeError with the received number) and
  // answers the per-field diffs; the record evaluates ONCE through an
  // interned helper (the X509Certificate precedent). Typed non-record
  // prevs (Node's ERR_INVALID_ARG_TYPE shapes) keep a pointed fence.
  if (member === "cpuUsage" || member === "threadCpuUsage") {
    const prefix = member === "cpuUsage" ? "cpu" : "threadCpu";
    const t = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (t?.kind !== "record") lowerer.badType(call, lowerer.typeOf(call));
    const shape = lowerer.shapes.get(t.shapeId);
    if (!shape || shape.fields.length !== 2 || !shape.fields.every((f) => f.type.kind === "f64")) {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    const sampleField = (name: string): IrExpr => ({
      kind: "libCall",
      fn: (name === "user" ? `process.${prefix}User` : `process.${prefix}System`) as IrLibFn,
      args: [],
      type: F64,
      loc,
    });
    if (call.arguments.nodes.length === 0) {
      return {
        kind: "recordLit",
        fields: shape.fields.map((f) => ({ name: f.name, value: sampleField(f.name) })),
        type: t,
        loc,
      };
    }
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(`process.${member} with ${call.arguments.nodes.length} arguments`, call);
    }
    const prev = lowerer.lowerExpr(call.arguments.nodes[0]!);
    const prevShape =
      prev.type.kind === "record" ? lowerer.shapes.get(prev.type.shapeId) : undefined;
    const prevOk =
      prevShape !== undefined &&
      ["user", "system"].every((n) =>
        prevShape.fields.some((f) => f.name === n && f.type.kind === "f64"),
      );
    if (prev.type.kind !== "record" || !prevOk) {
      lowerer.noLowering(
        `process.${member} of a '${lowerer.fmt(prev.type)}' previous value`,
        call.arguments.nodes[0]!,
        "the previous value is the record a prior call answered ({ user, system } numbers) — Node's ERR_INVALID_ARG_TYPE shapes have no lowering",
      );
    }
    const prevT = prev.type;
    const key = `${prefix}usage.diff:${prevT.shapeId}:${t.shapeId}`;
    let helper = lowerer.valueHelpers.get(key);
    if (!helper) {
      helper = keyedHelperName(lowerer, `%${prefix}usage.diff`, key);
      lowerer.valueHelpers.set(key, helper);
      const pRef: IrExpr = { kind: "varRef", localId: "p.0", type: prevT, loc };
      const fieldOf = (name: string): IrExpr => ({
        kind: "recordGet",
        obj: pRef,
        shapeId: prevT.shapeId,
        field: name,
        type: F64,
        loc,
      });
      const diffField = (name: string): IrExpr => ({
        kind: "libCall",
        fn: (name === "user"
          ? `process.${prefix}UserDiff`
          : `process.${prefix}SystemDiff`) as IrLibFn,
        args: [fieldOf(name)],
        type: F64,
        loc,
      });
      lowerer.liftedFns.push({
        name: helper,
        params: [{ localId: "p.0", name: "p", type: prevT }],
        returnType: t,
        locals: [{ id: "p.0", name: "p", type: prevT, mutable: false }],
        body: [
          // Node validates prevValue.user THEN prevValue.system, before
          // any sampling — the RangeError order the suite pins.
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "process.cpuPrevValidate",
              args: [fieldOf("user"), fieldOf("system")],
              type: VOID,
              loc,
            },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "recordLit",
              fields: shape.fields.map((f) => ({ name: f.name, value: diffField(f.name) })),
              type: t,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [prev], type: t, loc };
  }
  // process.memoryUsage() — rss from the OS, heapTotal/heapUsed from the
  // runtime heap's own accounting, external and arrayBuffers 0 (byte
  // storage lives in the same heap). One sample per call: the interned
  // helper takes it, then the record reads it field by field.
  if (member === "memoryUsage") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`process.memoryUsage with ${call.arguments.nodes.length} arguments`, call);
    }
    const t = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (t?.kind !== "record") lowerer.badType(call, lowerer.typeOf(call));
    const shape = lowerer.shapes.get(t.shapeId);
    if (
      !shape ||
      !shape.fields.every((f) => MEMORY_USAGE_FIELDS.includes(f.name) && f.type.kind === "f64")
    ) {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    const key = `process.memoryUsage:${t.shapeId}`;
    let helper = lowerer.valueHelpers.get(key);
    if (!helper) {
      helper = keyedHelperName(lowerer, "%process.memoryUsage", key);
      lowerer.valueHelpers.set(key, helper);
      lowerer.liftedFns.push({
        name: helper,
        params: [],
        returnType: t,
        locals: [],
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "libCall", fn: "process.memoryUsageTake", args: [], type: VOID, loc },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "recordLit",
              fields: shape.fields.map((f) => ({
                name: f.name,
                value: {
                  kind: "libCall",
                  fn: "process.memoryUsageField",
                  args: [numLit(MEMORY_USAGE_FIELDS.indexOf(f.name), loc)],
                  type: F64,
                  loc,
                } as IrExpr,
              })),
              type: t,
              loc,
            },
            loc,
          },
        ],
        loc,
      });
    }
    return { kind: "call", callee: helper, args: [], type: t, loc };
  }
  // process.resourceUsage() — getrusage's 16 fields in Node's names and
  // units (CPU times in microseconds, maxRSS in kilobytes).
  if (member === "resourceUsage") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(
        `process.resourceUsage with ${call.arguments.nodes.length} arguments`,
        call,
      );
    }
    const t = lowerer.mapTypeOf(lowerer.typeOf(call));
    if (t?.kind !== "record") lowerer.badType(call, lowerer.typeOf(call));
    const shape = lowerer.shapes.get(t.shapeId);
    const RUSAGE_FIELDS = [
      "userCPUTime",
      "systemCPUTime",
      "maxRSS",
      "sharedMemorySize",
      "unsharedDataSize",
      "unsharedStackSize",
      "minorPageFault",
      "majorPageFault",
      "swappedOut",
      "fsRead",
      "fsWrite",
      "ipcSent",
      "ipcReceived",
      "signalsCount",
      "voluntaryContextSwitches",
      "involuntaryContextSwitches",
    ];
    if (
      !shape ||
      !shape.fields.every((f) => RUSAGE_FIELDS.includes(f.name) && f.type.kind === "f64")
    ) {
      lowerer.badType(call, lowerer.typeOf(call));
    }
    return {
      kind: "recordLit",
      fields: shape.fields.map((f) => ({
        name: f.name,
        value: {
          kind: "libCall",
          fn: "process.rusage",
          args: [{ kind: "numLit", value: RUSAGE_FIELDS.indexOf(f.name), type: F64, loc }],
          type: F64,
          loc,
        } as IrExpr,
      })),
      type: t,
      loc,
    };
  }
  // process.getActiveResourcesInfo() — the loop's own bookkeeping:
  // 'Timeout' per armed timer (a firing, uncleared one included —
  // Node's lifetime) and 'Immediate' per queued, unfired immediate.
  // DIVERGENCE (SEMANTICS.md): resources this runtime does not model
  // as loop handles (TCP wraps, FS requests) are absent from the answer.
  if (member === "getActiveResourcesInfo") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(
        `process.getActiveResourcesInfo with ${call.arguments.nodes.length} arguments`,
        call,
      );
    }
    return { kind: "libCall", fn: "process.activeResources", args: [], type: arrayOf(STRING), loc };
  }
  // umask(2): the no-argument form reads without setting (the frontend
  // completes it to the -1 read sentinel); umask(mask) sets and answers
  // the previous mask, Node's shape either way.
  if (member === "umask") {
    if (call.arguments.nodes.length > 1) {
      lowerer.noLowering(`process.umask with ${call.arguments.nodes.length} arguments`, call);
    }
    const mask: IrExpr =
      call.arguments.nodes.length === 1
        ? lowerer.lowerExpr(call.arguments.nodes[0]!)
        : { kind: "numLit", value: -1, type: F64, loc };
    if (mask.type.kind !== "f64") {
      lowerer.noLowering("process.umask of non-number masks", call.arguments.nodes[0]!);
    }
    return { kind: "libCall", fn: "process.umask", args: [mask], type: F64, loc };
  }
  // chdir(2) — throws Node's fs-shaped error on failure.
  if (member === "chdir") {
    if (call.arguments.nodes.length !== 1) {
      lowerer.noLowering(`process.chdir with ${call.arguments.nodes.length} arguments`, call);
    }
    const dir = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (dir.type.kind !== "string") {
      lowerer.noLowering("process.chdir of non-string paths", call.arguments.nodes[0]!);
    }
    return { kind: "libCall", fn: "process.chdir", args: [dir], type: VOID, loc };
  }
  // getuid(2): POSIX-only target, so the call always answers a number —
  // the plain-f64 result is honest here even though @types/node declares
  // the member optional (that optionality covers Windows). The `?.()`
  // spelling routes here through lowerProcessOptionalMethodCall.
  if (PROCESS_CREDENTIAL_FNS.has(member)) {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`process.${member} with ${call.arguments.nodes.length} arguments`, call);
    }
    return processCredentialCall(member, loc);
  }
  // process.kill(pid, signal?) — Node's semantics exactly: the signal is
  // a name string (the runtime resolves Node's signal table; unknown
  // names throw the ERR_UNKNOWN_SIGNAL TypeError), a number (0 probes),
  // or omitted (SIGTERM); a non-int32 pid throws Node's
  // ERR_INVALID_ARG_TYPE TypeError text, and kill(2) failures throw
  // Node's `kill ESRCH`/`kill EPERM` Error. The result is Node's
  // constant true.
  if (member === "kill") {
    if (call.arguments.nodes.length < 1 || call.arguments.nodes.length > 2) {
      lowerer.noLowering(`process.kill with ${call.arguments.nodes.length} arguments`, call);
    }
    const pid = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, F64);
    const sigNode = call.arguments.nodes[1];
    if (!sigNode) {
      const dflt: IrExpr = { kind: "strLit", value: "SIGTERM", type: STRING, loc };
      return { kind: "libCall", fn: "process.kill", args: [pid, dflt], type: BOOL, loc };
    }
    const sig = lowerer.lowerExpr(sigNode);
    if (sig.type.kind === "f64") {
      return { kind: "libCall", fn: "process.killNum", args: [pid, sig], type: BOOL, loc };
    }
    if (sig.type.kind === "string") {
      return { kind: "libCall", fn: "process.kill", args: [pid, sig], type: BOOL, loc };
    }
    lowerer.noLowering(
      `process.kill with a '${lowerer.fmt(sig.type)}' signal`,
      sigNode,
      "pass a signal name string or number (narrow unions first)",
    );
  }
  if (member === "exit") {
    const arg = call.arguments.nodes[0];
    let code: IrExpr =
      arg !== undefined
        ? lowerer.lowerExprExpecting(arg, F64)
        : { kind: "libCall", fn: "process.currentExitCode", args: [], type: F64, loc };
    // process.exit(code) assigns process.exitCode before the 'exit'
    // listeners run. Only a program that reads the property can observe
    // that, so only such a program records the assignment.
    if (arg !== undefined && programReadsExitCode(lowerer)) {
      const binding = lowerer.declareHiddenLocal("%exitCode", F64);
      code = {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: binding.id, init: code, loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "process.setExitCodeTracked",
              args: [varRef(binding.id, F64, loc)],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        result: varRef(binding.id, F64, loc),
        type: F64,
        loc,
      };
    }
    return { kind: "libCall", fn: "process.exit", args: [code], type: VOID, loc };
  }
  return null; // process.argv(...) etc. are tsc errors before lowering
}

/** `process.getuid?.()` — the optional call of an optional process
 * method. On a POSIX target the member always exists, so the `?.` IS the
 * call (the checker's undefined arm covers Windows, which scriptc does
 * not target) and the honest result is the plain number. Intercepted
 * BEFORE the optional-chain machinery: `process.getuid` has no value
 * lowering for the chain to guard. Null when this isn't that shape. */
export function lowerProcessOptionalMethodCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
): IrExpr | null {
  // `process.send!(message)`: the asserted direct call of the optional
  // member (the @types/node spelling under strict null checks).
  if (
    !expr.questionDotToken &&
    ts.isNonNullExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    !expr.expression.expression.questionDotToken &&
    lowerer.stdlibGlobalMember(expr.expression.expression, "process") === "send"
  )
    return lowerProcessIpcSend(lowerer, expr);
  if (!expr.questionDotToken) return null;
  if (!ts.isPropertyAccessExpression(expr.expression)) return null;
  const member = lowerer.stdlibGlobalMember(expr.expression, "process");
  if (member === "send") return lowerProcessIpcSend(lowerer, expr);
  if (member === null || !PROCESS_CREDENTIAL_FNS.has(member)) return null;
  if (expr.arguments.nodes.length !== 0) {
    lowerer.noLowering(`process.${member} with ${expr.arguments.nodes.length} arguments`, expr);
  }
  return processCredentialCall(member, locOf(expr));
}

/** process.memoryUsage()'s fields in Node's order — the runtime's
 * sample index. */
const MEMORY_USAGE_FIELDS = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"];

/** The POSIX credential readers @types/node declares optional (Windows
 * has none): getuid(2), getgid(2), geteuid(2), getegid(2), and
 * getgroups(2). */
const PROCESS_CREDENTIAL_FNS: ReadonlyMap<string, IrLibFn> = new Map([
  ["getuid", "process.getuid"],
  ["getgid", "process.getgid"],
  ["geteuid", "process.geteuid"],
  ["getegid", "process.getegid"],
  ["getgroups", "process.getgroups"],
]);

function processCredentialCall(member: string, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: PROCESS_CREDENTIAL_FNS.get(member)!,
    args: [],
    type: member === "getgroups" ? arrayOf(F64) : F64,
    loc,
  };
}

/** `process.getBuiltinModule("node:os")`: a string-literal id naming a
 * supported builtin whose call the checker types as that module's
 * namespace (@types/node's BuiltInModule map) answers the namespace value
 * `import * as ns` binds, so its members key the builtin tables at their
 * use sites. The receiver may be cast (`(process as P)`) and the call
 * optional: Node 24's process always has the member, and the cast changes
 * no runtime value. Other ids keep the dynamic loader (undefined for
 * unknown ids, Node's argument errors). */
export function lowerProcessBuiltinModuleNamespace(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "getBuiltinModule")
    return null;
  const id = call.arguments.nodes[0];
  if (call.arguments.nodes.length !== 1 || !id || !ts.isStringLiteralLike(id)) return null;
  let receiver: ts.Expression = callee.expression;
  while (
    ts.isParenthesizedExpression(receiver) ||
    ts.isAsExpression(receiver) ||
    ts.isSatisfiesExpression(receiver) ||
    ts.isNonNullExpression(receiver)
  )
    receiver = receiver.expression;
  if (!lowerer.isStdlibGlobal(receiver, "process")) return null;
  const module = canonicalBuiltinModule(id.text);
  if (module === null) return null;
  const type = lowerer.mapTypeOf(lowerer.checker.getNonNullableType(lowerer.typeOf(call)));
  if (type?.kind !== "moduleNs" || type.moduleId !== `builtin:${module}`) return null;
  return { kind: "moduleNsRef", moduleId: type.moduleId, type, loc: locOf(call) };
}
