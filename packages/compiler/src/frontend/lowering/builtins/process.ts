import { envSnapshotHelper, lowerProcessLoadEnvFile } from "./environment.js";
import { dynUndefinedExpr, boolLit, numLit, strLit, varRef } from "../../../ir/build.js";
import { timerStyleCallback } from "../lower-timers.js";
import * as ts from "../../ts7/adapter.js";
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
  STRING,
  UNDEFINED_T,
  VOID,
  arrayOf,
  canBoxFuncIntoDyn,
  funcOf,
} from "../../../ir/ir.js";
import { lowerBuiltinLoaderValue } from "../lower-builtin-values.js";
import { lowerProcessIpcSend, ipcMessageListener, ipcDisconnectListener } from "./ipc.js";
import { lowerDiagnosticsSubscriber, lowerTracingArguments } from "./async-context.js";

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
  if (isJsSourceFile(call.getSourceFile())) {
    const receiver = lowerer.lowerExpr(access.expression);
    if (receiver.type.kind === "dyn") {
      return {
        kind: "dynInvoke",
        recv: receiver,
        method: name,
        calleeName: call.expression.getText(),
        args: call.arguments.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      };
    }
  }
  if (name === "getWindowSize" && call.arguments.length === 0) {
    const receiver = lowerer.coerceToExpected(lowerer.lowerExpr(access.expression), DYN);
    return lowerer.coerceInto(
      call,
      {
        kind: "dynInvoke",
        recv: receiver,
        method: name,
        calleeName: call.expression.getText(),
        args: [],
        type: DYN,
        loc,
      },
      lowerer.irTypeOf(call),
    );
  }
  if (name === "write" && call.arguments.length === 1) {
    const receiver = lowerer.lowerExpr(access.expression);
    const data = lowerer.lowerExpr(call.arguments[0]!);
    if (data.type.kind !== "string") {
      lowerer.noLowering(
        `write of '${lowerer.fmt(data.type)}' data on a stream value`,
        call.arguments[0]!,
        "one string is the supported form here — narrow unions first",
      );
    }
    return { kind: "libCall", fn: "procStream.write", args: [receiver, data], type: BOOL, loc };
  }
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
    isJsSourceFile(expr.getSourceFile()) &&
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
  if (member === "versions") {
    return { kind: "libCall", fn: "process.versions", args: [], type: DYN, loc };
  }
  if (member === "hrtime") {
    return { kind: "libCall", fn: "process.hrtimeValue", args: [], type: DYN, loc };
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
  // process.execArgv: the extra CLI arguments Node itself consumed — a
  // compiled binary consumed none, so the honest answer is a fresh [].
  if (member === "execArgv") {
    return { kind: "arrayLit", elems: [], type: arrayOf(STRING), loc };
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
    ((member === "stdout" || member === "stderr") && isJsSourceFile(expr.getSourceFile()))
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
  if (isJsSourceFile(call.getSourceFile()) && ts.isPropertyAccessExpression(access.expression)) {
    const stream = lowerer.stdlibGlobalMember(access.expression, "process");
    if (stream === "stdin" || stream === "stdout" || stream === "stderr") {
      if (call.arguments.some(ts.isSpreadElement))
        lowerer.noLowering("process stream spread arguments", call);
      return {
        kind: "dynInvoke",
        recv: lowerer.lowerExpr(access.expression),
        method: access.name.text,
        calleeName: access.getText(),
        args: call.arguments.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc: locOf(call),
      };
    }
  }
  const directProcessMember = lowerer.stdlibGlobalMember(access, "process");
  if (directProcessMember === "loadEnvFile") return lowerProcessLoadEnvFile(lowerer, call);
  if (directProcessMember === "hrtime") {
    if (call.arguments.some(ts.isSpreadElement))
      lowerer.noLowering("process.hrtime with spread arguments", call);
    const loc = locOf(call);
    return {
      kind: "dynCall",
      callee: { kind: "libCall", fn: "process.hrtimeValue", args: [], type: DYN, loc },
      args: call.arguments.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
      calleeName: "process.hrtime",
      type: DYN,
      loc,
    };
  }
  if (directProcessMember === "getBuiltinModule") {
    if (call.arguments.some(ts.isSpreadElement))
      lowerer.noLowering("process.getBuiltinModule with spread arguments", call);
    const loc = locOf(call);
    const id = call.arguments[0]
      ? lowerer.lowerExprExpecting(call.arguments[0], DYN)
      : (dynUndefinedExpr(loc) satisfies IrExpr);
    const binding = lowerer.declareHiddenLocal("%builtinId", DYN);
    return {
      kind: "seqExpr",
      stmts: [
        { kind: "varDecl", localId: binding.id, init: id, loc },
        ...call.arguments.slice(1).map((arg): IrStmt => ({
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
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`process.disconnect with ${call.arguments.length} arguments`, call);
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
    if (call.arguments.length !== 0) {
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
    if (call.arguments.length !== 1) {
      lowerer.noLowering(
        `stdin.setRawMode with ${call.arguments.length} arguments`,
        call,
        "the supported form is setRawMode(mode) with one boolean",
      );
    }
    const mode = lowerer.lowerExpr(call.arguments[0]!);
    if (mode.type.kind !== "bool") {
      lowerer.noLowering(
        `stdin.setRawMode of '${lowerer.fmt(mode.type)}' modes`,
        call.arguments[0]!,
        "the mode is a boolean here — narrow unions first",
      );
    }
    return { kind: "libCall", fn: "process.stdinSetRawMode", args: [mode], type: VOID, loc };
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
    if (call.arguments.length !== 2) {
      lowerer.noLowering(`stdin.${access.name.text} with ${call.arguments.length} arguments`, call);
    }
    const evT = lowerer.typeOf(call.arguments[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event !== "data" && event !== "end" && event !== "error") {
      lowerer.noLowering(
        `stdin.${access.name.text}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments[0]!,
        '"data", "end", and "error" are the supported stdin events (as literals)',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining stdin listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    const cb = lowerer.lowerExpr(call.arguments[1]!);
    if (cb.type.kind !== "func" || cb.type.ret.kind !== "void" || cb.type.params.length > 1) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        "stdin listeners with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    const onceArg: IrExpr = { kind: "boolLit", value: once, type: BOOL, loc };
    if (event === "data") {
      if (param !== undefined && !(param.kind === "bytes" && param.elem === "u8")) {
        lowerer.unsupported(
          "SC1090",
          call.arguments[1]!,
          `data listeners whose parameter is not 'Uint8Array' (got '${lowerer.fmt(param)}')`,
        );
      }
      return { kind: "libCall", fn: "stdin.onData", args: [cb, onceArg], type: VOID, loc };
    }
    if (event === "end") {
      if (param !== undefined) {
        lowerer.unsupported("SC1090", call.arguments[1]!, "end listeners with parameters (use ())");
      }
      return { kind: "libCall", fn: "stdin.onEnd", args: [cb, onceArg], type: VOID, loc };
    }
    if (param !== undefined && !(param.kind === "object" && param.className === "%Error")) {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
        `error listeners whose parameter is not 'Error' (got '${lowerer.fmt(param)}')`,
      );
    }
    return { kind: "libCall", fn: "stdin.onError", args: [cb, onceArg], type: VOID, loc };
  }
  if (access.name.text === "write" && ts.isPropertyAccessExpression(access.expression)) {
    const stream = lowerer.stdlibGlobalMember(access.expression, "process");
    if (stream === "stdout" || stream === "stderr") {
      const loc = locOf(call);
      const args = call.arguments;
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
      if (data.type.kind === "dyn" && isJsSourceFile(call.getSourceFile())) {
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
        if (callback.type.kind === "dyn" && isJsSourceFile(call.getSourceFile())) {
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
    if (call.arguments.length !== 2) {
      lowerer.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
    }
    const evT = lowerer.typeOf(call.arguments[0]!);
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
          ? ipcMessageListener(lowerer, call.arguments[1]!)
          : ipcDisconnectListener(lowerer, call.arguments[1]!);
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
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments[1]!);
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
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments[1]!);
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
    // 'warning': the listener crosses as a dyn function; emitWarning
    // and the runtime deprecation sites dispatch synchronously
    // (SEMANTICS.md). off/removeListener remove by closure identity.
    if (event === "warning" && (member === "on" || isOff)) {
      if (!ts.isExpressionStatement(call.parent)) {
        lowerer.unsupported(
          "SC1090",
          call,
          "chaining process listener registration (the result is void here — register each listener as its own statement)",
        );
      }
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments[1]!);
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
      const name = lowerer.coerceToExpected(lowerer.lowerExpr(call.arguments[0]!), STRING);
      if (name.type.kind !== "string" && name.type.kind !== "dyn") {
        lowerer.noLowering("process signal event name that is not a string", call.arguments[0]!);
      }
      const signal =
        name.type.kind === "string"
          ? name
          : { kind: "dynCheck" as const, value: name, type: STRING, loc };
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments[1]!);
      return {
        kind: "libCall",
        fn: isOff ? "process.offSignal" : "process.onSignal",
        args: isOff ? [signal, cb] : [signal, cb, boolLit(member === "once", loc)],
        type: VOID,
        loc,
      };
    }
    if (event !== "exit") {
      lowerer.noLowering(`process.${member}("${event}", ...)`, call.arguments[0]!);
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining process listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    let cb = lowerer.lowerExpr(call.arguments[1]!);
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
        call.arguments[1]!,
        "process listeners with more than one parameter or a return value",
      );
    }
    const param = cb.type.params[0];
    const onceArg: IrExpr = { kind: "boolLit", value: member === "once", type: BOOL, loc };
    if (param !== undefined && param.kind !== "f64") {
      lowerer.unsupported(
        "SC1090",
        call.arguments[1]!,
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
    if (call.arguments.length === 1 && ts.isSpreadElement(call.arguments[0]!)) {
      const spread = lowerer.lowerExpr(call.arguments[0]!.expression);
      if (spread.type.kind === "dyn") {
        argsArr = spread;
      } else {
        lowerer.noLowering(
          "process.emitWarning with a typed spread argument",
          call.arguments[0]!,
          "spread an untyped (checked-dynamic) array, or write the arguments positionally",
        );
      }
    } else {
      argsArr = lowerTracingArguments(lowerer, call.arguments, loc);
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
    if (call.arguments.length === 0) {
      lowerer.noLowering(
        "process.nextTick with 0 arguments",
        call,
        "the supported form is process.nextTick(callback, ...args)",
      );
    }
    const cb = timerStyleCallback(lowerer, call.arguments, "process.nextTick", loc);
    return { kind: "libCall", fn: "process.nextTick", args: [cb], type: VOID, loc };
  }
  // The process introspection statics — plain reads of the process's
  // own clocks and counters, Node's shapes exactly.
  if (member === "uptime" || member === "availableMemory" || member === "constrainedMemory") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
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
    if (call.arguments.length === 0) {
      return {
        kind: "recordLit",
        fields: shape.fields.map((f) => ({ name: f.name, value: sampleField(f.name) })),
        type: t,
        loc,
      };
    }
    if (call.arguments.length !== 1) {
      lowerer.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
    }
    const prev = lowerer.lowerExpr(call.arguments[0]!);
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
        call.arguments[0]!,
        "the previous value is the record a prior call answered ({ user, system } numbers) — Node's ERR_INVALID_ARG_TYPE shapes have no lowering",
      );
    }
    const prevT = prev.type;
    const key = `${prefix}usage.diff:${prevT.shapeId}:${t.shapeId}`;
    let helper = lowerer.valueHelpers.get(key);
    if (!helper) {
      helper = `%${prefix}usage.diff.${lowerer.valueHelpers.size}`;
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
  // process.resourceUsage() — getrusage's 16 fields in Node's names and
  // units (CPU times in microseconds, maxRSS in kilobytes).
  if (member === "resourceUsage") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`process.resourceUsage with ${call.arguments.length} arguments`, call);
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
    if (call.arguments.length !== 0) {
      lowerer.noLowering(
        `process.getActiveResourcesInfo with ${call.arguments.length} arguments`,
        call,
      );
    }
    return { kind: "libCall", fn: "process.activeResources", args: [], type: arrayOf(STRING), loc };
  }
  // umask(2): the no-argument form reads without setting (the frontend
  // completes it to the -1 read sentinel); umask(mask) sets and answers
  // the previous mask, Node's shape either way.
  if (member === "umask") {
    if (call.arguments.length > 1) {
      lowerer.noLowering(`process.umask with ${call.arguments.length} arguments`, call);
    }
    const mask: IrExpr =
      call.arguments.length === 1
        ? lowerer.lowerExpr(call.arguments[0]!)
        : { kind: "numLit", value: -1, type: F64, loc };
    if (mask.type.kind !== "f64") {
      lowerer.noLowering("process.umask of non-number masks", call.arguments[0]!);
    }
    return { kind: "libCall", fn: "process.umask", args: [mask], type: F64, loc };
  }
  // chdir(2) — throws Node's fs-shaped error on failure.
  if (member === "chdir") {
    if (call.arguments.length !== 1) {
      lowerer.noLowering(`process.chdir with ${call.arguments.length} arguments`, call);
    }
    const dir = lowerer.lowerExpr(call.arguments[0]!);
    if (dir.type.kind !== "string") {
      lowerer.noLowering("process.chdir of non-string paths", call.arguments[0]!);
    }
    return { kind: "libCall", fn: "process.chdir", args: [dir], type: VOID, loc };
  }
  // getuid(2): POSIX-only target, so the call always answers a number —
  // the plain-f64 result is honest here even though @types/node declares
  // the member optional (that optionality covers Windows). The `?.()`
  // spelling routes here through lowerProcessOptionalMethodCall.
  if (member === "getuid" || member === "getgid") {
    if (call.arguments.length !== 0) {
      lowerer.noLowering(`process.${member} with ${call.arguments.length} arguments`, call);
    }
    return {
      kind: "libCall",
      fn: member === "getuid" ? "process.getuid" : "process.getgid",
      args: [],
      type: F64,
      loc,
    };
  }
  // process.kill(pid, signal?) — Node's semantics exactly: the signal is
  // a name string (the runtime resolves Node's signal table; unknown
  // names throw the ERR_UNKNOWN_SIGNAL TypeError), a number (0 probes),
  // or omitted (SIGTERM); a non-int32 pid throws Node's
  // ERR_INVALID_ARG_TYPE TypeError text, and kill(2) failures throw
  // Node's `kill ESRCH`/`kill EPERM` Error. The result is Node's
  // constant true.
  if (member === "kill") {
    if (call.arguments.length < 1 || call.arguments.length > 2) {
      lowerer.noLowering(`process.kill with ${call.arguments.length} arguments`, call);
    }
    const pid = lowerer.lowerExprExpecting(call.arguments[0]!, F64);
    const sigNode = call.arguments[1];
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
    const arg = call.arguments[0];
    const code: IrExpr =
      arg !== undefined
        ? lowerer.lowerExprExpecting(arg, F64)
        : { kind: "libCall", fn: "process.currentExitCode", args: [], type: F64, loc };
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
  if (!expr.questionDotToken) return null;
  if (!ts.isPropertyAccessExpression(expr.expression)) return null;
  const member = lowerer.stdlibGlobalMember(expr.expression, "process");
  if (member === "send") return lowerProcessIpcSend(lowerer, expr);
  if (member !== "getuid" && member !== "getgid") return null;
  if (expr.arguments.length !== 0) {
    lowerer.noLowering(`process.${member} with ${expr.arguments.length} arguments`, expr);
  }
  return {
    kind: "libCall",
    fn: member === "getuid" ? "process.getuid" : "process.getgid",
    args: [],
    type: F64,
    loc: locOf(expr),
  };
}
