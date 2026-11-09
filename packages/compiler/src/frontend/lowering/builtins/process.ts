import { keyedHelperName } from "../stable-names.js";
import { stdinKeypressListener } from "./readline.js";
import { envSnapshotHelper, lowerProcessLoadEnvFile } from "./environment.js";
import { dynUndefinedExpr, boolLit, numLit, strLit, varRef } from "../../../ir/build.js";
import { timerStyleCallback } from "../lower-timers.js";
import * as ts from "../../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../../outer-expressions.js";
import { requestGeneralStreamSurface } from "../general-streams.js";
import { isGeneralNodeStreamInterface } from "../../type-mapper.js";
import { type Lowerer, own } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { isSafeToDiscard } from "../expressions/evaluation-safety.js";
import { resultIsDiscarded } from "../call-position.js";
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
  isUnitType,
  setOf,
  typeKey,
} from "../../../ir/ir.js";
import { lowerBuiltinLoaderValue } from "../lower-builtin-values.js";
import { builtinFunctionValue } from "../lower-exprs.js";
import { canonicalBuiltinModule } from "../../builtin-modules.js";
import {
  lowerProcessIpcDisconnect,
  lowerProcessIpcSend,
  ipcMessageListener,
  ipcDisconnectListener,
} from "./ipc.js";
import { lowerDiagnosticsSubscriber, lowerTracingArguments } from "./async-context.js";
import { isCheckerPanic } from "../../../diagnostics/diagnostic.js";
import { refuseCallbackThis } from "../callback-arg.js";

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

/** Whether any program file replaces a process output stream's write
 * method: `process.stdout.write = …` / `process.stderr.write = …`, or the
 * same assignment through a first-class alias of the stream (a value whose
 * type maps to the process stream). Such a program routes its typed
 * stdout/stderr writes through the stream object, so the replacement sees
 * them with their arguments, as in Node. Cached per program. Node islands
 * need no such scan: a program that holds the stream object at all shares
 * its write slot with them (the stdioObject runtime feature). */
export function programPatchesStdio(lowerer: Lowerer): boolean {
  if (lowerer.patchesStdio !== null) return lowerer.patchesStdio;
  let found = false;
  const isStream = (recv: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(recv)) {
      const direct = lowerer.stdlibGlobalMember(recv, "process");
      if (direct === "stdout" || direct === "stderr") return true;
    }
    // An arbitrary receiver's mapping is a query, never a commit: a checker
    // panic (the type has no readable form) is not a patch site.
    try {
      return lowerer.mapTypeOf(lowerer.typeOf(recv))?.kind === "procStream";
    } catch (e) {
      if (!isCheckerPanic(e)) throw e;
      return false;
    }
  };
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "write"
    ) {
      if (isStream(node.left.expression)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, walk);
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    walk(sf);
    if (found) break;
  }
  lowerer.patchesStdio = found;
  return found;
}

/** The pinned Node release the runtime reports as process.versions.node
 * (packages/runtime/src/scr_lib.c SCR_NODE_COMPAT_VERSION, kept equal to
 * internal/compatibility/node-v24.json by test/node-pin.test.ts). */
export const NODE_COMPAT_VERSION = "24.22.1";

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
  const declared = lowerer.mapTypeOf(lowerer.typeOf(access.expression));
  const stored =
    declared?.kind === "procStream" || !ts.isIdentifier(access.expression)
      ? undefined
      : (lowerer.peekLocal(access.expression)?.type ?? lowerer.globalOf(access.expression)?.type);
  // A binding that kept the descriptor of a stream under a record
  // annotation (`const sink: Sink = process.stdout`) still names that
  // stream: its `write` member is the stream's own method.
  if (declared?.kind !== "procStream" && stored?.kind !== "procStream") return null;
  if (!lowerer.isStdlibMember(access) && access.name.text !== "write") return null;
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
  const terminalArity = TERMINAL_STREAM_METHODS.get(name);
  if (
    terminalArity !== undefined &&
    !(call.questionDotToken !== undefined && isJsSourceFile(ts.getSourceFileOfNode(call))) &&
    call.arguments.nodes.length <= terminalArity &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    noteTerminalColorRefusal(lowerer, call, name);
    const invoke = (stream: IrExpr): IrExpr =>
      lowerer.coerceInto(
        call,
        {
          kind: "dynInvoke",
          recv: lowerer.coerceToExpected(stream, DYN),
          method: name,
          calleeName: ts.getTextOfNode(call.expression),
          args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        },
        lowerer.irTypeOf(call),
      );
    const stream = lowerer.lowerExpr(access.expression);
    // getWindowSize's pair keeps the plain call: an optional pair has no
    // compiled form yet.
    if (
      call.questionDotToken === undefined ||
      stream.type.kind !== "procStream" ||
      name === "getWindowSize"
    )
      return invoke(stream);
    // `out.getColorDepth?.(env)`: the stream has the method exactly when its
    // descriptor is a terminal, which is when it has `isTTY`. The stream is
    // evaluated once; on a pipe the call and its arguments never run and the
    // answer is undefined, whatever the declarations promise.
    refuseAssertedTerminalAnswer(lowerer, call, access, name);
    const held = lowerer.declareHiddenLocal("%terminalStream", stream.type);
    const read: IrExpr = { kind: "varRef", localId: held.id, type: stream.type, loc };
    const terminal = processStreamValueMember(lowerer, "isTTY", read, loc);
    const body = invoke(read);
    const type = lowerer.withUndefinedArmOf(body.type);
    if (terminal === null || type === null) return body;
    return {
      kind: "seqExpr",
      stmts: [{ kind: "varDecl", localId: held.id, init: stream, loc }],
      result: {
        kind: "optChain",
        id: lowerer.closureName(loc, "", "chain"),
        receiver: terminal,
        body: lowerer.coerceToExpected(body, type),
        type,
        loc,
      },
      type,
      loc,
    };
  }
  const viaObject = lowerProcStreamObjectCall(lowerer, call, access);
  if (viaObject !== null) return viaObject;
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
    isGeneralNodeStreamInterface(
      lowerer.checker.getNonNullableType(lowerer.typeOf(access.expression)),
      lowerer.typeCtx,
    )
      ? "write(data) with one string and getWindowSize() are the supported stream-value methods"
      : "write(data[, encoding][, callback]), listeners for 'resize' and 'error' (as literals), getWindowSize(), getColorDepth([env]) and hasColors([count][, env]) are the supported stream-value methods",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** The methods a process stream has only while its descriptor is a terminal
 * (Node's tty.WriteStream; a piped or redirected stream is a net.Socket or a
 * file stream and has none of them), with the most arguments each takes. The
 * runtime's stream object serves them with Node's own semantics: the window
 * size, and the color depth Node derives from an environment object. */
const TERMINAL_STREAM_METHODS: ReadonlyMap<string, number> = new Map([
  ["getWindowSize", 0],
  ["getColorDepth", 1],
  ["hasColors", 2],
]);

/** The kinds of environment argument the runtime's color rules refuse: Node
 * reads variables from any object, and only a plain object has a compiled
 * reading. */
const REFUSED_COLOR_ENVIRONMENTS: ReadonlySet<string> = new Set(["array", "map", "set", "func"]);

/** The `TERM` values that name a member of Object.prototype in Node's table
 * of terminals (the table is a plain object and the lookup lowercases the
 * value): Node answers that member, which is no color depth. */
const PROTOTYPE_TERMS: ReadonlySet<string> = new Set(["constructor", "__proto__"]);

/** SC6015 for a `getColorDepth` or `hasColors` call whose environment
 * argument the build can see the runtime refuses when the call runs: an
 * environment that is no plain object, or a literal environment whose one
 * variable is a `TERM` naming a member of Object.prototype. An environment
 * the build cannot see (a parameter, the process's own variables) is not
 * named: the runtime's refusal names itself when such a call throws. */
function noteTerminalColorRefusal(lowerer: Lowerer, call: ts.CallExpression, name: string): void {
  if (name !== "getColorDepth" && name !== "hasColors") return;
  const args = call.arguments.nodes;
  // hasColors([count][, env]): a lone argument is the environment unless it
  // is a number.
  let env = name === "hasColors" && args.length === 2 ? args[1] : args[0];
  if (env === undefined) return;
  while (ts.isParenthesizedExpression(env)) env = env.expression;
  const hint =
    'pass a plain object of variables (`{ TERM: "xterm" }`, `process.env`), or no environment at all';
  const type = lowerer.mapTypeOf(lowerer.typeOf(env));
  if (type && REFUSED_COLOR_ENVIRONMENTS.has(type.kind)) {
    lowerer.noteDeferredRefusal(
      call,
      `SC2020: Native process stream ${name} with an environment that is not a plain object has no lowering`,
      hint,
    );
    return;
  }
  if (!ts.isObjectLiteralExpression(env) || env.properties.nodes.length !== 1) return;
  const only = env.properties.nodes[0]!;
  if (!ts.isPropertyAssignment(only) || !ts.isStringLiteralLike(only.initializer)) return;
  const key = only.name;
  if (!(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) || key.text !== "TERM") return;
  if (!PROTOTYPE_TERMS.has(only.initializer.text.toLowerCase())) return;
  lowerer.noteDeferredRefusal(
    call,
    "SC2020: Native process stream getColorDepth for a TERM that names a member of Object.prototype has no lowering",
    "name a terminal Node knows (`xterm`, `linux`, `screen`); Node answers the member of Object.prototype for this value, which is no color depth",
  );
}

/** Refuses an assertion that the optional call of a process stream's color
 * method answered (`out.getColorDepth?.() as number`, `…!`). The stream has
 * the method only on a terminal, so on a pipe or a file the call answers
 * undefined: Node lets that undefined through the assertion, and a slot of
 * the asserted type cannot hold it. */
function refuseAssertedTerminalAnswer(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  name: string,
): void {
  if (name !== "getColorDepth" && name !== "hasColors") return;
  let node: ts.Node = call;
  while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const assertion = node.parent;
  if (!assertion) return;
  if (!ts.isNonNullExpression(assertion)) {
    if (!ts.isAsExpression(assertion) && !ts.isTypeAssertion(assertion)) return;
    const asserted = lowerer.mapTypeOf(lowerer.typeOf(assertion));
    // An assertion to a type that still holds undefined, or to an untyped
    // one, asserts nothing about the answer.
    if (
      !asserted ||
      asserted.kind === "dyn" ||
      asserted.kind === "void" ||
      asserted.kind === "undefinedT" ||
      (asserted.kind === "union" && lowerer.armTag(asserted.unionId, UNDEFINED_T) >= 0)
    )
      return;
  }
  lowerer.noLowering(
    `an asserted answer of WritableStream.${name}?.()`,
    assertion,
    "the stream has the method only on a terminal, and on a pipe or a file the optional call answers undefined: test the answer (`?? 1`, `=== undefined`) instead of asserting it",
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Whether `node` reads one of those methods from a process stream: a member
 * the declarations require and a stream that is no terminal does not have,
 * so an optional call of it (`out.getColorDepth?.()`) is a real test. */
export function isTerminalStreamMethodRead(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) || !TERMINAL_STREAM_METHODS.has(node.name.text))
    return false;
  // A JavaScript source reads the member from the stream object and tests
  // the value it gets.
  if (isJsSourceFile(ts.getSourceFileOfNode(node))) return false;
  return lowerer.mapTypeOf(lowerer.typeOf(node.expression))?.kind === "procStream";
}

/** The event names the runtime's process stream object takes listeners
 * for on stdout and stderr. */
const PROC_STREAM_EVENTS: ReadonlySet<string> = new Set(["resize", "error"]);

/** The listener methods of the runtime's process stream object. */
const PROC_STREAM_LISTENER_METHODS: ReadonlySet<string> = new Set([
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
]);

/** Whether a written chunk is one the stream object's write takes: a
 * string, a byte view, or a union of the two. */
function isProcStreamChunk(lowerer: Lowerer, type: IrType): boolean {
  if (type.kind === "string") return true;
  if (type.kind === "bytes") return type.elem === "u8";
  if (type.kind !== "union") return false;
  const arms = lowerer.unions.get(type.unionId)?.arms ?? [];
  return arms.length > 0 && arms.every((arm) => isProcStreamChunk(lowerer, arm));
}

/** Calls on a process stream value that the runtime's stream object serves
 * with Node's own semantics: `on` / `once` / `off` / `addListener` /
 * `removeListener` for 'resize' and 'error', and `write` with a byte chunk,
 * an encoding or a completion callback. The call is made on the stream
 * object, as a JavaScript source's is; the one-string write keeps its
 * direct form. A receiver declared as one of the general stream interfaces
 * is left to the general representation (general-streams.ts). Null for any
 * other call. */
function lowerProcStreamObjectCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const name = access.name.text;
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement)) return null;
  const listener = PROC_STREAM_LISTENER_METHODS.has(name);
  if (listener) {
    if (args.length !== 2) return null;
    const event = lowerer.typeOf(args[0]!);
    if (!event.isStringLiteralType() || !PROC_STREAM_EVENTS.has(event.value)) return null;
  } else if (name !== "write" || args.length < 1 || args.length > 3) {
    return null;
  }
  const declared = lowerer.checker.getNonNullableType(lowerer.typeOf(access.expression));
  if (isGeneralNodeStreamInterface(declared, lowerer.typeCtx)) return null;
  const loc = locOf(call);
  const stream = lowerer.lowerExpr(access.expression);
  if (stream.type.kind !== "procStream") return null;
  let lowered: IrExpr[];
  if (listener) {
    lowered = args.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  } else {
    const chunk = lowerer.lowerExpr(args[0]!);
    // The one-string write is the direct descriptor write.
    if (args.length === 1 && chunk.type.kind === "string") {
      return { kind: "libCall", fn: "procStream.write", args: [stream, chunk], type: BOOL, loc };
    }
    if (!isProcStreamChunk(lowerer, chunk.type)) {
      lowerer.noLowering(
        `write of '${lowerer.fmt(chunk.type)}' data on a stream value`,
        args[0]!,
        "a string or a Uint8Array is the supported data here — narrow unions first",
      );
    }
    lowered = [
      lowerer.coerceToExpected(chunk, DYN),
      ...args.slice(1).map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    ];
  }
  const invoke = (recv: IrExpr): IrExpr => ({
    kind: "dynInvoke",
    recv: { kind: "dynFrom", value: recv, type: DYN, loc: recv.loc },
    method: name,
    calleeName: ts.getTextOfNode(call.expression),
    args: lowered,
    type: DYN,
    loc,
  });
  if (resultIsDiscarded(call)) return invoke(stream);
  // write answers Node's boolean.
  if (!listener) return lowerer.coerceToExpected(invoke(stream), BOOL);
  // A listener method answers the stream it was called on.
  const kept = lowerer.declareHiddenLocal("%procStream", PROCSTREAM_T);
  const receiver = varRef(kept.id, PROCSTREAM_T, loc);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: kept.id, init: stream, loc },
      { kind: "exprStmt", expr: invoke(receiver), loc },
    ],
    result: receiver,
    type: PROCSTREAM_T,
    loc,
  };
}

/** Standard streams expose optional terminal properties: pipes have no
 * isTTY, columns, or rows, and only a TTY stdin has a raw-mode flag. The
 * declarations do not prove their presence. */
export function isOptionalProcessStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  if (!OPTIONAL_PROCESS_STREAM_MEMBERS.includes(expr.name.text)) return false;
  let recv = expr.expression;
  while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isTypeAssertion(recv))
    recv = recv.expression;
  if (ts.isPropertyAccessExpression(recv)) {
    const stream = lowerer.stdlibGlobalMember(recv, "process");
    if (
      stream === "stdout" ||
      stream === "stderr" ||
      (stream === "stdin" && (expr.name.text === "isTTY" || expr.name.text === "isRaw"))
    )
      return true;
  }
  return (
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "procStream" ||
    isTerminalStreamMember(lowerer, expr)
  );
}

/** Whether the member read is declared by the standard library's terminal
 * streams: tty.ReadStream and tty.WriteStream, which the types of
 * process.stdin, process.stdout and process.stderr extend, or the fallback
 * declaration of process.stdin (a type literal). A value of such a type
 * may be a pipe or a file at run time (`const input = process.stdin`, a
 * parameter typed `NodeJS.ReadStream`), where Node has no such property. */
export function isTerminalStreamMember(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): boolean {
  if (!OPTIONAL_PROCESS_STREAM_MEMBERS.includes(expr.name.text)) return false;
  return isTerminalStreamSymbol(lowerer, lowerer.checker.getSymbolAtLocation(expr.name));
}

function isTerminalStreamSymbol(lowerer: Lowerer, symbol: ts.Symbol | undefined): boolean {
  if (!symbol || symbol.declarations.length === 0 || !lowerer.isStdlibSymbol(symbol)) return false;
  return symbol.declarations.every((declaration) => {
    const owner = declaration.parent;
    if (owner === undefined) return false;
    if (ts.isTypeLiteralNode(owner)) return true;
    if (!ts.isClassDeclaration(owner) && !ts.isInterfaceDeclaration(owner)) return false;
    const name = owner.name?.text;
    return name === "ReadStream" || name === "WriteStream";
  });
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
    .some((sf) => !sf.isDeclarationFile && ts.sourceTextIncludes(sf, "versions"));
  return lowerer.mentionsProcessVersions;
}

/** The members a process stream has only on a terminal (and `isRaw` only
 * on a terminal stdin): a pipe or a file has none of them. */
export const OPTIONAL_PROCESS_STREAM_MEMBERS: readonly string[] = [
  "isTTY",
  "columns",
  "rows",
  "isRaw",
];

/** Whether an object pattern's source is a process stream: a value of the
 * process-stream type (`process.stdout`, `process.stderr`, an alias, a
 * parameter), `process.stdin` itself, whose value is the stream object, or
 * a dynamic value of a terminal stream type (an alias of `process.stdin`). */
export function isProcessStreamPatternSource(
  lowerer: Lowerer,
  source: ts.Expression,
  sourceType: IrType | null,
): boolean {
  if (sourceType?.kind === "procStream") return true;
  const e = withoutParenthesesTypeWrappers(source);
  if (ts.isPropertyAccessExpression(e)) {
    const stream = lowerer.stdlibGlobalMember(e, "process");
    if (stream === "stdin" || stream === "stdout" || stream === "stderr") return true;
  }
  // A value of a terminal stream type that is dynamic (`const input =
  // process.stdin`): its terminal members are absent off a terminal too.
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(source));
  return isTerminalStreamSymbol(lowerer, lowerer.checker.getPropertyOfType(type, "isTTY"));
}

/** The members a process stream VALUE answers as data, wherever the value
 * came from (an alias, a parameter, a call result, a destructuring source).
 * One table for the member read `stream.columns` and the pattern
 * `const { columns } = stream`. */
export const PROCESS_STREAM_VALUE_MEMBERS: readonly string[] = [
  "isTTY",
  "columns",
  "rows",
  "fd",
  "isRaw",
  "writableLength",
  "writableHighWaterMark",
  "writableNeedDrain",
];

/** The members of a process output stream that do not depend on the stream:
 * the compiled binary's fd 1/2 writes are synchronous, so nothing is ever
 * queued (Node's writableLength is always 0 and the drain flag never set),
 * and the high-water mark is Node's default. Null for other members. */
function processStreamConstantMember(member: string, loc: SrcLoc): IrExpr | null {
  if (member === "writableNeedDrain") return { kind: "boolLit", value: false, type: BOOL, loc };
  if (member === "writableLength") return { kind: "numLit", value: 0, type: F64, loc };
  if (member === "writableHighWaterMark") return { kind: "numLit", value: 65536, type: F64, loc };
  return null;
}

/** A data member read off a process stream value: `receiver` is the value
 * (the stream's descriptor scalar, or the stream object it boxes to). The
 * stream-independent members answer their constants; the others are keyed
 * reads of the runtime's stream object, which answers the live values
 * (isatty, the terminal's geometry, the descriptor) and undefined where
 * Node has no such property (a pipe has no isTTY, columns or rows). Null
 * for a member outside PROCESS_STREAM_VALUE_MEMBERS. The receiver is read
 * for the keyed members only: a caller with an effectful receiver
 * evaluates it itself for the constants. */
export function processStreamValueMember(
  lowerer: Lowerer,
  member: string,
  receiver: IrExpr,
  loc: SrcLoc,
): IrExpr | null {
  if (!PROCESS_STREAM_VALUE_MEMBERS.includes(member)) return null;
  const constant = processStreamConstantMember(member, loc);
  if (constant !== null) return constant;
  return lowerer.coerceToExpected(
    {
      kind: "dynKeyGet",
      value: lowerer.coerceToExpected(receiver, DYN),
      key: strLit(member, loc),
      type: DYN,
      loc,
    },
    lowerer.withUndefinedArm(member === "isTTY" ? BOOL : F64),
  );
}

export function lowerProcessStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken && !lowerer.chainHandled.has(expr)) return null;
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
  // The write method as a VALUE in TypeScript (`const original =
  // process.stdout.write`, `process.stdout.write.bind(process.stdout)`):
  // the stream object's current write slot, a checked-dynamic function
  // (the native method until a program replaces it).
  if (member === "write" && (direct === "stdout" || direct === "stderr")) {
    const loc = locOf(expr);
    return {
      kind: "dynKeyGet",
      value: {
        kind: "libCall",
        fn: "process.stdioSlot",
        args: [numLit(direct === "stdout" ? 1 : 2, loc)],
        type: DYN,
        loc,
      },
      key: strLit("write", locOf(expr.name)),
      type: DYN,
      loc,
    };
  }
  // The same value through a first-class stream (`const original =
  // out.write` where `out: NodeJS.WriteStream` holds stdout or stderr): the
  // write slot of the stream object the value names.
  if (
    member === "write" &&
    direct === null &&
    !isJsSourceFile(ts.getSourceFileOfNode(expr)) &&
    lowerer.mapTypeOf(lowerer.typeOf(expr.expression))?.kind === "procStream"
  ) {
    const out = lowerer.lowerExpr(expr.expression);
    if (out.type.kind === "procStream") {
      return {
        kind: "dynKeyGet",
        value: lowerer.coerceToExpected(out, DYN),
        key: strLit("write", locOf(expr.name)),
        type: DYN,
        loc: locOf(expr),
      };
    }
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
  // process.stdin.readableLength: the bytes waiting in the read buffer
  // (Node's Readable#readableLength). Only stdin has the readable side;
  // its held input is the runtime's buffer.
  if (direct === "stdin" && member === "readableLength") {
    return { kind: "libCall", fn: "stdin.readableLength", args: [], type: F64, loc: locOf(expr) };
  }
  if (
    member !== "isTTY" &&
    member !== "columns" &&
    member !== "rows" &&
    member !== "writableLength" &&
    member !== "fd" &&
    member !== "isRaw" &&
    member !== "writableHighWaterMark" &&
    member !== "writableNeedDrain"
  )
    return null;
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
    // A FIRST-CLASS ALIAS of the stream (`const out = process.stdout;
    // out.writableLength`): processStreamValueMember, the one reading of a
    // member off a stream VALUE.
    const constant = processStreamConstantMember(member, locOf(expr));
    if (constant !== null) {
      // The receiver still EVALUATES: a call or property read that hands
      // back the stream runs its own side effects — and throws where Node
      // throws — before the constant answers, exactly as the read of the
      // member would. A pure receiver (the alias above) folds away.
      const effect = lowerer.lowerExpr(expr.expression);
      if (isSafeToDiscard(effect)) return constant;
      return {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: effect, loc: locOf(expr.expression) }],
        result: constant,
        type: constant.type,
        loc: locOf(expr),
      };
    }
    return processStreamValueMember(
      lowerer,
      member,
      lowerer.lowerExpr(expr.expression),
      locOf(expr),
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
  // The compiled binary writes to fd 1/2 SYNCHRONOUSLY: when the call
  // returns, the bytes have reached the descriptor and nothing is queued
  // in the stream's buffer — Node's number, always 0 (`write()` answers
  // true for the same reason). Backpressure probes read 0 and stay
  // correct; the write itself never defers.
  if (member === "writableLength") return { kind: "numLit", value: 0, type: F64, loc };
  // Node's default high-water mark for the process streams, and the
  // drain flag a synchronous write never sets.
  if (member === "writableHighWaterMark") {
    if (stream === "stdin") return null;
    return { kind: "numLit", value: 65536, type: F64, loc };
  }
  if (member === "writableNeedDrain") {
    if (stream === "stdin") return null;
    return { kind: "boolLit", value: false, type: BOOL, loc };
  }
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
  if (member === "fd") {
    // The process streams are built over fd 0/1/2 (Node answers those on
    // a TTY, a pipe, and a redirected file alike).
    return {
      kind: "numLit",
      value: stream === "stdin" ? 0 : stream === "stdout" ? 1 : 2,
      type: F64,
      loc,
    };
  }
  if (stream === "stdin") {
    if (member !== "isRaw") return null;
    // Node answers the raw-mode flag of a TTY stdin and undefined on
    // anything else (a pipe-backed stdin); the runtime sentinel carries
    // both (scr_process_stdin_is_raw).
    return {
      kind: "libCall",
      fn: "process.stdinIsRaw",
      args: [],
      type: lowerer.withUndefinedArm(BOOL),
      loc,
    };
  }
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
    case "execArgv":
      return { kind: "libCall", fn: "process.execArgv", args: [], type: arrayOf(STRING), loc };
    case "release":
      // One object, the one the spelled `process.release` reads.
      return { kind: "libCall", fn: "process.release", args: [], type: DYN, loc };
    case "allowedNodeEnvironmentFlags":
      return { kind: "libCall", fn: "process.allowedEnvFlags", args: [], type: setOf(STRING), loc };
    case "versions":
      return { kind: "libCall", fn: "process.versions", args: [], type: DYN, loc };
    case "features":
      return { kind: "libCall", fn: "process.features", args: [], type: DYN, loc };
    default:
      return null;
  }
}

/** The function members of the process object that have a function value:
 * what `process.<member>` read as a value answers, and what the same member
 * of a stored process object answers (node-value-reads.ts), so the two are
 * one function. Null for the members that are call-only or have no
 * lowering. `js` is whether the read is in a JavaScript source; `held` is
 * whether the member is built for a stored process object, not spelled. */
export function processFunctionMemberValue(
  lowerer: Lowerer,
  member: string,
  loc: SrcLoc,
  js: boolean,
  held = false,
): IrExpr | null {
  if (member === "hrtime") {
    return { kind: "libCall", fn: "process.hrtimeValue", args: [], type: DYN, loc };
  }
  // A stored process.nextTick in JavaScript (`cond ? setImmediate :
  // process.nextTick`): the interned builtin function value.
  if (member === "nextTick" && js) return builtinFunctionValue("process.nextTick", loc);
  if (member === "getBuiltinModule") {
    // Keep the native loader's argument validation when the function is
    // stored. The declaration's string signature must not insert a checked
    // adapter before the loader gets to report Node's invalid-id error.
    return { kind: "dynFrom", value: lowerBuiltinLoaderValue(lowerer, loc, held), type: DYN, loc };
  }
  // process.cwd as a value: the process module's member (surfaces.ts).
  if (member === "cwd")
    return lowerer.lowerBuiltinCallableValue({ module: "process", member }, loc);
  return null;
}

/** process.features: Node's own keys in Node's order (lib/internal/
 * bootstrap/node.js), each with the value that is true of a compiled
 * binary. Where a flag describes a capability the program can use, the
 * value is whether scriptc implements it; where it describes Node's own
 * build, it says what is linked here. The runtime's process.features
 * object (scr_process_features) holds the same table.
 *
 * - inspector: no V8 inspector is linked (Node reports false too when it is
 *   built without one).
 * - debug: not a debug build of Node.
 * - uv: no libuv is linked; process.versions.uv is absent for the same
 *   reason.
 * - ipv6: the net unit binds and connects over IPv6.
 * - tls, tls_alpn, tls_sni: the tls module, ALPNProtocols and servername
 *   are implemented.
 * - tls_ocsp: requestOCSP has no implementation (a runtime fence), so a
 *   program must not be told to wait for an 'OCSPResponse'.
 * - openssl_is_boringssl: the TLS library is not BoringSSL.
 * - cached_builtins: there are no JavaScript builtins to code-cache.
 * - require_module: require() of an ES module compiles and runs.
 * - quic: no QUIC implementation.
 * - typescript: the binary cannot load TypeScript source at run time;
 *   Node's "strip" would tell a loader that import() of a .ts path works. */
export const PROCESS_FEATURES: readonly (readonly [name: string, value: boolean])[] = [
  ["inspector", false],
  ["debug", false],
  ["uv", false],
  ["ipv6", true],
  ["tls_alpn", true],
  ["tls_sni", true],
  ["tls_ocsp", false],
  ["tls", true],
  ["openssl_is_boringssl", false],
  ["cached_builtins", false],
  ["require_module", true],
  ["quic", false],
  ["typescript", false],
];

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
  // process.features.<flag>: Node's own keys answer the compiled binary's
  // value (PROCESS_FEATURES); any other name reads undefined, as it does
  // on Node's object. The fold is sound because the runtime's object
  // (scr_process_features) accepts no write and no new key: a program that
  // holds the object can never make it disagree with these constants.
  // The capability-probe members that honestly DON'T EXIST in a
  // compiled binary — each reads undefined (their declared types carry
  // the undefined arm), so feature probes take their documented
  // fallbacks: no gyp build config (process.config.variables.* — no QUIC
  // — and process.config.target_defaults; v8_enable_i18n_support is the
  // exception below, answered from the binary's linked ICU).
  if (!expr.questionDotToken && ts.isPropertyAccessExpression(expr.expression)) {
    const container = lowerer.stdlibGlobalMember(expr.expression, "process");
    if (container === "features") {
      const loc = locOf(expr);
      const flag = PROCESS_FEATURES.find(([name]) => name === expr.name.text);
      if (flag === undefined) return { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc };
      return boolLit(flag[1], loc);
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
      // The one variable a compiled binary can answer truthfully:
      // v8_enable_i18n_support. Node bundles ICU and answers the number 1;
      // this read selects the `icu` runtime feature (scr_intl.c), so a
      // binary that reports ICU is a binary that carries it.
      if (expr.name.text === "v8_enable_i18n_support") {
        return { kind: "libCall", fn: "icu.i18nSupport", args: [], type: F64, loc: locOf(expr) };
      }
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
  // process.features as a value (`"sea" in process.features`, Object.keys,
  // a stored alias): one stable object holding the flags the member reads
  // above answer, in Node's key order.
  if (member === "features") {
    return { kind: "libCall", fn: "process.features", args: [], type: DYN, loc };
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
  {
    const value = processFunctionMemberValue(
      lowerer,
      member,
      loc,
      isJsSourceFile(ts.getSourceFileOfNode(expr)),
    );
    if (value !== null) return value;
  }
  if (member === "argv") {
    return { kind: "libCall", fn: "process.argv", args: [], type: arrayOf(STRING), loc };
  }
  if (member === "connected") {
    // The channel's state, false without a channel. A JavaScript source
    // reads undefined there, as Node does (node-value-reads.ts
    // untypedNodeMemberRead); a TypeScript read is typed boolean by its
    // declaration.
    return { kind: "libCall", fn: "process.connected", args: [], type: BOOL, loc };
  }
  // process.execArgv: the Node runtime flags kept out of process.argv —
  // a leading --test-update-snapshots in node:test programs, else [].
  if (member === "execArgv") {
    return { kind: "libCall", fn: "process.execArgv", args: [], type: arrayOf(STRING), loc };
  }
  // process.allowedNodeEnvironmentFlags: one stable set of the option
  // names the compatibility target's NODE_OPTIONS accepts (the same
  // identity on every read, like Node's).
  if (member === "allowedNodeEnvironmentFlags") {
    return { kind: "libCall", fn: "process.allowedEnvFlags", args: [], type: setOf(STRING), loc };
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
  // process.report: the diagnostic report is answered by the Node island,
  // which is this same process — one bridge call, no native
  // reimplementation, and sharedObjects lists the binary's real libraries.
  // A build without islands keeps the member fence that names
  // process.report (no report is fabricated here).
  if (member === "report") {
    if (lowerer.nodeIslands === null) return null;
    return { kind: "libCall", fn: "nodeIsland.processReport", args: [], type: DYN, loc };
  }
  // process.execPath: the compiled binary's own resolved absolute path —
  // the honest answer where Node's is the node executable's (SEMANTICS.md
  // divergence 12, the argv[0]/argv[1] precedent).
  if (member === "execPath") {
    return { kind: "libCall", fn: "process.execPath", args: [], type: STRING, loc };
  }
  if (member === "env") {
    let mapped = lowerer.mapTypeOf(lowerer.typeOf(expr));
    // `(globalThis as { process?: { env?: E } }).process?.env`: the cast
    // types env as optional, but Node always defines it. Snapshot into the
    // record arm; the caller's coercion wraps it into the optional type.
    if (mapped?.kind === "union") {
      const arms = lowerer.unions.get(mapped.unionId)?.arms ?? [];
      const records = arms.filter((arm) => arm.kind === "record");
      if (records.length === 1 && arms.every((arm) => arm.kind === "record" || isUnitType(arm)))
        mapped = records[0]!;
    }
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
      const loc = locOf(call);
      // The one-argument string form of write: the runtime writes the text
      // for an unreplaced write, and a replaced write still receives the
      // call with the string as its only argument. Static for the handle
      // receivers, which read their write slot when they are called, so
      // reading it in the runtime keeps the order JavaScript has.
      const only = call.arguments.nodes[0];
      if (
        stream !== "stdin" &&
        access.name.text === "write" &&
        call.arguments.nodes.length === 1 &&
        only !== undefined &&
        lowerer.mapTypeOf(lowerer.typeOf(only))?.kind === "string"
      ) {
        return {
          kind: "libCall",
          fn: "process.stdioWriteStr",
          args: [numLit(stream === "stderr" ? 2 : 1, loc), lowerer.lowerExpr(only)],
          type: DYN,
          loc,
        };
      }
      return {
        kind: "dynInvoke",
        recv: lowerer.lowerExpr(access.expression),
        method: access.name.text,
        calleeName: ts.getTextOfNode(access),
        args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
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
  if (directProcessMember === "disconnect") return lowerProcessIpcDisconnect(lowerer, call);
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
  // process.stdin.pause() / resume() / isPaused() / read([size]): the
  // readable side of the stream, Node's paused-mode surface. pause() and
  // resume() set the flowing flag (input arrives buffered for read() and
  // the 'readable' event while paused, and reaches 'data' listeners
  // again on resume); Node answers `this`, and that composition has no
  // lowering, so statement position is required. isPaused() answers the
  // flag — true while a 'readable' listener pins paused mode. read()
  // takes held input with Node's size coercion (truncation, "read all"
  // for NaN, nothing for a non-positive size, ERR_OUT_OF_RANGE above
  // 1 GiB) and answers `Uint8Array | null`. A JavaScript file the checker
  // does not type keeps the stream object's untyped members: its dyn read()
  // answers a value whose own methods (Buffer#toString(encoding)) still
  // lower, which a `Uint8Array | null` union cannot.
  if (
    !isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    ts.isPropertyAccessExpression(access.expression) &&
    lowerer.stdlibGlobalMember(access.expression, "process") === "stdin"
  ) {
    const loc = locOf(call);
    const member = access.name.text;
    const args = call.arguments.nodes;
    if (member === "pause" || member === "resume") {
      if (args.length !== 0) {
        lowerer.noLowering(`stdin.${member} with ${args.length} arguments`, call);
      }
      if (!ts.isExpressionStatement(call.parent) && !ts.isArrowFunction(call.parent)) {
        lowerer.unsupported(
          "SC1090",
          call,
          `using the result of stdin.${member}() (the ReadStream chain — call it as its own statement)`,
        );
      }
      return {
        kind: "libCall",
        fn: member === "pause" ? "stdin.pause" : "stdin.resume",
        args: [],
        type: VOID,
        loc,
      };
    }
    if (member === "isPaused") {
      if (args.length !== 0) {
        lowerer.noLowering(`stdin.isPaused with ${args.length} arguments`, call);
      }
      return { kind: "libCall", fn: "stdin.isPaused", args: [], type: BOOL, loc };
    }
    if (member === "read") {
      if (args.length > 1) {
        lowerer.noLowering(
          `stdin.read with ${args.length} arguments`,
          call,
          "the supported form is read([size])",
        );
      }
      if (args.some(ts.isSpreadElement)) {
        lowerer.noLowering("stdin.read with a spread argument", call);
      }
      const sizeNode = args[0];
      // read(undefined) is read(), as in Node: the undefined size reads
      // everything held rather than coercing through a number. A size
      // argument written out still evaluates — Node evaluates every
      // argument before the call, so its side effects and throws are the
      // read's — it just contributes 0.
      const all =
        sizeNode === undefined || (lowerer.typeOf(sizeNode).flags & ts.TypeFlags.Undefined) !== 0;
      const size: IrExpr = !all
        ? lowerer.lowerExprExpecting(sizeNode!, F64)
        : sizeNode === undefined
          ? numLit(0, loc)
          : {
              kind: "seqExpr",
              stmts: [{ kind: "exprStmt", expr: lowerer.lowerExpr(sizeNode), loc }],
              result: numLit(0, loc),
              type: F64,
              loc,
            };
      // The interner's identity is the typeKey-SORTED arm list.
      const arms: IrType[] = [BYTES_U8, { kind: "nullT" }];
      arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
      const type: IrType = { kind: "union", unionId: lowerer.unions.intern(arms) };
      const read: IrExpr = {
        kind: "libCall",
        fn: "stdin.read",
        args: [boolLit(all, loc), size],
        type,
        loc,
      };
      return lowerer.maybeNarrow(read, call);
    }
  }
  // process.stdout/stderr.on("drain", fn) and its spellings: Node emits
  // 'drain' only after a write() returned false, and these writes are
  // synchronous (they never return false), so the listener can never run.
  // Registering it is therefore observably a no-op: the receiver and the
  // listener are evaluated for their effects and nothing is retained.
  // listenerCount/listeners/eventNames on the process streams stay
  // refused, so the missing registration cannot be observed.
  if (
    [
      "on",
      "once",
      "off",
      "addListener",
      "removeListener",
      "prependListener",
      "prependOnceListener",
    ].includes(access.name.text) &&
    ts.isPropertyAccessExpression(access.expression) &&
    call.arguments.nodes.length === 2 &&
    !call.arguments.nodes.some(ts.isSpreadElement)
  ) {
    const stream = lowerer.stdlibGlobalMember(access.expression, "process");
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    if (
      (stream === "stdout" || stream === "stderr") &&
      evT.isStringLiteralType() &&
      evT.value === "drain"
    ) {
      const loc = locOf(call);
      const parent = call.parent;
      const discarded =
        ts.isExpressionStatement(parent) || (ts.isArrowFunction(parent) && parent.body === call);
      if (!discarded) {
        lowerer.unsupported(
          "SC1090",
          call,
          `using the result of process.${stream}.${access.name.text}("drain", ...) (register it as its own statement)`,
        );
      }
      const stmts: IrStmt[] = [];
      for (const arg of call.arguments.nodes) {
        const value = lowerer.lowerExprExpecting(arg, DYN);
        if (!isSafeToDiscard(value)) stmts.push({ kind: "exprStmt", expr: value, loc: value.loc });
      }
      // The call's value is discarded (statement position or a void arrow
      // body), so the lowering is the evaluated arguments alone; a bare
      // unitLit has no standalone IR value, so the no-op result is the
      // dynamic undefined a discarded call leaves.
      const result: IrExpr = dynUndefinedExpr(loc);
      return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: DYN, loc };
    }
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
    if (
      event !== "data" &&
      event !== "end" &&
      event !== "error" &&
      event !== "readable" &&
      event !== "keypress"
    ) {
      lowerer.noLowering(
        `stdin.${access.name.text}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments.nodes[0]!,
        '"data", "end", "error", "readable", and "keypress" are the supported stdin events (as literals)',
      );
    }
    if (!resultIsDiscarded(call)) {
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
    if (event === "end" || event === "readable") {
      if (param !== undefined) {
        lowerer.unsupported(
          "SC1090",
          call.arguments.nodes[1]!,
          `${event} listeners with parameters (use ())`,
        );
      }
      return {
        kind: "libCall",
        fn: event === "end" ? "stdin.onEnd" : "stdin.onReadable",
        args: [cb, onceArg],
        type: VOID,
        loc,
      };
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
      // In a program that replaces a process stream's write, a write call is
      // what Node makes it: a call of the stream's CURRENT write property,
      // with the arguments as passed (the replacement sees byte chunks,
      // encodings and callbacks). The native method behind the slot is the
      // same synchronous write, so an unpatched stream behaves as before.
      if (programPatchesStdio(lowerer) && !args.some(ts.isSpreadElement)) {
        const handle: IrExpr = {
          kind: "libCall",
          fn: "process.stdioSlot",
          args: [numLit(stream === "stdout" ? 1 : 2, loc)],
          type: DYN,
          loc,
        };
        const invoke: IrExpr = {
          kind: "dynInvoke",
          recv: handle,
          method: "write",
          calleeName: ts.getTextOfNode(access),
          args: args.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
          type: DYN,
          loc,
        };
        // The declared boolean: a replacement returning something else
        // throws at a use that needs the boolean (types do not lie); a
        // discarded result is not converted.
        return resultIsDiscarded(call) ? invoke : lowerer.coerceToExpected(invoke, BOOL);
      }
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
      // A chunk known only at run time (`any`, or a string | Uint8Array
      // union): the runtime dispatches on the value — a string or a
      // Uint8Array/Buffer writes, null throws ERR_STREAM_NULL_VALUES, any
      // other value throws ERR_INVALID_ARG_TYPE, as Node's Writable.write
      // does before writing anything. Only the one-argument form.
      if (
        args.length === 1 &&
        (data.type.kind === "dyn" || data.type.kind === "union") &&
        (data.type.kind === "dyn" || lowerer.dynConvertible(data.type))
      ) {
        return {
          kind: "libCall",
          fn: "process.stdioWriteDyn",
          args: [numLit(stream === "stdout" ? 1 : 2, loc), lowerer.coerceToExpected(data, DYN)],
          type: BOOL,
          loc,
        };
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
  // process.prependListener(event, cb): Node's front-of-list registration.
  // The signal, 'exit', and 'uncaughtException'/'uncaughtExceptionMonitor'
  // registries have a prepend entry; every other family registers by
  // appending only, so it refuses rather than reordering silently.
  // prependOnceListener has no runtime entry at all.
  const isPrepend = member === "prependListener";
  if (member === "prependOnceListener") {
    lowerer.noLowering(
      "process.prependOnceListener",
      access,
      "use prependListener or once (prependOnceListener has no lowering)",
    );
  }
  if (member === "on" || member === "once" || isOff || isPrepend) {
    if (call.arguments.nodes.length !== 2) {
      lowerer.noLowering(`process.${member} with ${call.arguments.nodes.length} arguments`, call);
    }
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if ((event === "message" || event === "disconnect") && !isOff) {
      if (isPrepend) {
        lowerer.noLowering(
          `process.prependListener("${event}", ...)`,
          call,
          "prependListener is supported for signals, 'exit', and 'uncaughtException' (register these families with on/once)",
        );
      }
      if (!resultIsDiscarded(call)) {
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
      if (!resultIsDiscarded(call)) {
        lowerer.unsupported("SC1090", call, "chaining process exception listener registration");
      }
      const cb = lowerDiagnosticsSubscriber(lowerer, call.arguments.nodes[1]!);
      const monitor = boolLit(event === "uncaughtExceptionMonitor", loc);
      return {
        kind: "libCall",
        fn: isOff
          ? "process.offUncaughtException"
          : isPrepend
            ? "process.prependUncaughtException"
            : "process.onUncaughtException",
        args: isOff
          ? [cb, monitor]
          : isPrepend
            ? [cb, monitor]
            : [cb, boolLit(member === "once", loc), monitor],
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
      if (isPrepend) {
        lowerer.noLowering(
          `process.prependListener("${event}", ...)`,
          call,
          "prependListener is supported for signals, 'exit', and 'uncaughtException' (register these families with on/once)",
        );
      }
      if (!resultIsDiscarded(call)) {
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
      if (isPrepend) {
        lowerer.noLowering(
          'process.prependListener("warning", ...)',
          call,
          "prependListener is supported for signals, 'exit', and 'uncaughtException' (register this family with on)",
        );
      }
      if (!resultIsDiscarded(call)) {
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
      if (!resultIsDiscarded(call)) {
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
        fn: isOff ? "process.offSignal" : isPrepend ? "process.prependSignal" : "process.onSignal",
        args: isOff
          ? [signal, cb]
          : isPrepend
            ? [signal, cb]
            : [signal, cb, boolLit(member === "once", loc)],
        type: VOID,
        loc,
      };
    }
    if (event !== "exit") {
      lowerer.noLowering(`process.${member}("${event}", ...)`, call.arguments.nodes[0]!);
    }
    if (!resultIsDiscarded(call)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining process listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    refuseCallbackThis(lowerer, call.arguments.nodes[1]!, "a process listener", "'process'");
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
    if (isPrepend) {
      return { kind: "libCall", fn: "process.prependExit", args: [cb], type: VOID, loc };
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
  // `process.send!(message)` and `process.disconnect!()`: the asserted
  // direct call of the optional member (the @types/node spelling under
  // strict null checks).
  if (
    !expr.questionDotToken &&
    ts.isNonNullExpression(expr.expression) &&
    ts.isPropertyAccessExpression(expr.expression.expression) &&
    !expr.expression.expression.questionDotToken
  ) {
    const asserted = lowerer.stdlibGlobalMember(expr.expression.expression, "process");
    if (asserted === "send") return lowerProcessIpcSend(lowerer, expr);
    if (asserted === "disconnect") return lowerProcessIpcDisconnect(lowerer, expr);
  }
  if (!expr.questionDotToken) return null;
  if (!ts.isPropertyAccessExpression(expr.expression)) return null;
  const member = lowerer.stdlibGlobalMember(expr.expression, "process");
  if (member === "send") return lowerProcessIpcSend(lowerer, expr);
  if (member === "disconnect") return lowerProcessIpcDisconnect(lowerer, expr);
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
