import { boolLit, strLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { requestGeneralStreamSurface } from "../general-streams.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { isChildSurfaceMember } from "../surfaces.js";
import { bufEncoding } from "../containers/bytes.js";
import {
  BOOL,
  CHILDSTREAM_T,
  CHILDWRITER_T,
  DYN,
  type IrExpr,
  type IrType,
  STRING,
  VOID,
  canBoxFuncIntoDyn,
} from "../../../ir/ir.js";
import {
  ipcJsonMessage,
  ipcSendCallback,
  ipcMessageListener,
  ipcDisconnectListener,
} from "./ipc.js";
import { stripTypeCasts } from "./arguments.js";

export function lowerChildMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "child") return null;
  if (!isChildSurfaceMember(lowerer, access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "send") {
    if (
      call.arguments.nodes.length < 1 ||
      call.arguments.nodes.length > 2 ||
      call.arguments.nodes.some(ts.isSpreadElement)
    ) {
      lowerer.noLowering(
        `child.send with ${call.arguments.nodes.length} arguments`,
        call,
        "send(message[, callback]) is supported; handle transfer and options are not",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const json = ipcJsonMessage(lowerer, call.arguments.nodes[0]!, loc);
    if (call.arguments.nodes[1] === undefined) {
      return { kind: "libCall", fn: "child.send", args: [receiver, json], type: BOOL, loc };
    }
    const callback = ipcSendCallback(lowerer, call.arguments.nodes[1]);
    return {
      kind: "libCall",
      fn: "child.sendCb",
      args: [receiver, json, callback],
      type: BOOL,
      loc,
    };
  }
  if (name === "disconnect" && call.arguments.nodes.length === 0) {
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        "using the result of child.disconnect() (call it as its own statement)",
      );
    }
    return {
      kind: "libCall",
      fn: "child.disconnect",
      args: [lowerer.lowerExpr(access.expression)],
      type: VOID,
      loc,
    };
  }
  if ((name === "on" || name === "once") && call.arguments.nodes.length === 2) {
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (
      event !== "spawn" &&
      event !== "exit" &&
      event !== "close" &&
      event !== "error" &&
      event !== "message" &&
      event !== "disconnect"
    ) {
      lowerer.noLowering(
        `child.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments.nodes[0]!,
        '"exit", "close", "error", "message", and "disconnect" are the supported child events (as literals)',
      );
    }
    // `child.on(...)` returns the child: a chained call or a stored result
    // reads the receiver, which evaluates once, before the listener.
    let receiver = lowerer.lowerExpr(access.expression);
    const chained = ts.isExpressionStatement(call.parent)
      ? null
      : {
          local: lowerer.declareHiddenLocal("%childListenerTarget", receiver.type),
          init: receiver,
        };
    if (chained) receiver = varRef(chained.local.id, chained.local.type, loc);
    const registered = (registration: IrExpr): IrExpr =>
      chained === null
        ? registration
        : {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: chained.local.id, init: chained.init, loc },
              { kind: "exprStmt", expr: registration, loc },
            ],
            result: varRef(chained.local.id, chained.local.type, loc),
            type: chained.local.type,
            loc,
          };
    const once: IrExpr = { kind: "boolLit", value: name === "once", type: BOOL, loc };
    if (event === "message") {
      return registered({
        kind: "libCall",
        fn: "child.onMessage",
        args: [receiver, ipcMessageListener(lowerer, call.arguments.nodes[1]!), once],
        type: VOID,
        loc,
      });
    }
    if (event === "disconnect") {
      return registered({
        kind: "libCall",
        fn: "child.onDisconnect",
        args: [receiver, ipcDisconnectListener(lowerer, call.arguments.nodes[1]!), once],
        type: VOID,
        loc,
      });
    }
    const listenerNode = stripTypeCasts(call.arguments.nodes[1]!);
    if (
      isJsSourceFile(ts.getSourceFileOfNode(listenerNode)) &&
      (ts.isArrowFunction(listenerNode) || ts.isFunctionExpression(listenerNode)) &&
      listenerNode.parameters.nodes.some((param) => param.dotDotDotToken) &&
      listenerNode.parameters.nodes.every((param) => !param.type) &&
      !/@(?:param|type)\b/.test(
        ts
          .getSourceFileOfNode(listenerNode)
          .text.slice(listenerNode.pos, ts.tokenStartOfNode(listenerNode)),
      )
    ) {
      for (const param of listenerNode.parameters.nodes) lowerer.checkedCallbackParams.add(param);
    }
    const narrowed =
      event === "exit" || event === "close"
        ? narrowedExitListenerParams(lowerer, listenerNode)
        : [];
    const cb =
      narrowed.length > 0
        ? lowerWithCheckedParams(lowerer, listenerNode, narrowed)
        : lowerer.lowerExpr(call.arguments.nodes[1]!);
    if (
      narrowed.length > 0 ||
      (isJsSourceFile(ts.getSourceFileOfNode(listenerNode)) && cb.type.kind === "dyn") ||
      (cb.type.kind === "func" &&
        (cb.type.rest ||
          (isJsSourceFile(ts.getSourceFileOfNode(listenerNode)) &&
            cb.type.params.some((param) => param.kind === "dyn"))))
    ) {
      if (
        cb.type.kind !== "dyn" &&
        !canBoxFuncIntoDyn(
          cb.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        lowerer.noLowering(
          "child event listeners with non-representable parameters",
          call.arguments.nodes[1]!,
        );
      }
      return registered({
        kind: "libCall",
        fn: "child.onDyn",
        args: [
          receiver,
          { kind: "strLit", value: event, type: STRING, loc },
          cb.type.kind === "dyn" ? cb : { kind: "dynFrom", value: cb, type: DYN, loc },
        ],
        type: VOID,
        loc,
      });
    }
    if (event === "spawn") {
      if (cb.type.kind !== "func" || cb.type.params.length !== 0 || cb.type.ret.kind !== "void") {
        lowerer.noLowering(
          "spawn event listeners with parameters or a returned value",
          call.arguments.nodes[1]!,
        );
      }
      return registered({
        kind: "libCall",
        fn: "child.onSpawn",
        args: [receiver, cb],
        type: VOID,
        loc,
      });
    }
    if (cb.type.kind !== "func" || cb.type.params.length > (event === "error" ? 1 : 2)) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        event !== "error"
          ? `${event} listeners with more than two parameters (use (code, signal), (code), or ())`
          : "error listeners with more than one parameter (use (err) or ())",
      );
    }
    if (cb.type.ret.kind !== "void") {
      // `() => 5` IS assignable to a void-returning listener slot; the
      // registry's call ABI is void, so a value-returning closure is
      // fenced instead of being called through the wrong ABI.
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        "listeners returning a value (make the callback body a block, or return nothing)",
      );
    }
    const param = cb.type.params[0];
    if (event === "exit" || event === "close") {
      const armsOk =
        param === undefined ||
        (param.kind === "union" &&
          (() => {
            const def = lowerer.unions.get(param.unionId);
            return (
              def?.arms.length === 2 && def.arms[0]!.kind === "f64" && def.arms[1]!.kind === "nullT"
            );
          })());
      if (!armsOk) {
        lowerer.unsupported(
          "SC1090",
          call.arguments.nodes[1]!,
          `${event} listeners whose parameter is not 'number | null' (got '${lowerer.fmt(param!)}')`,
        );
      }
      // The optional SECOND parameter is Node's signal: the terminating
      // signal's name as `Signals | null` — a string | null union here
      // (the interned adapter builds it at fire time).
      const sigParam = cb.type.params[1];
      const sigOk =
        sigParam === undefined ||
        (sigParam.kind === "union" &&
          (() => {
            const def = lowerer.unions.get(sigParam.unionId);
            return (
              def?.arms.length === 2 &&
              def.arms.some((a) => a.kind === "string") &&
              def.arms.some((a) => a.kind === "nullT")
            );
          })());
      if (!sigOk) {
        lowerer.unsupported(
          "SC1090",
          call.arguments.nodes[1]!,
          `${event} listeners whose signal parameter is not 'Signals | null' (got '${lowerer.fmt(sigParam!)}')`,
        );
      }
      return registered({
        kind: "libCall",
        fn: event === "close" ? "child.onClose" : "child.onExit",
        args: [receiver, cb],
        type: VOID,
        loc,
      });
    }
    if (param !== undefined && !(param.kind === "object" && param.className === "%Error")) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        `error listeners whose parameter is not 'Error' (got '${lowerer.fmt(param)}')`,
      );
    }
    return registered({
      kind: "libCall",
      fn: "child.onError",
      args: [receiver, cb],
      type: VOID,
      loc,
    });
  }
  // child.kill(signal?) — Node's semantics exactly: the name resolves
  // through Node's signal table (unknown names throw the ERR_UNKNOWN_SIGNAL
  // TypeError), numbers pass through (0 probes), the omitted signal is
  // SIGTERM; true when the signal was sent, false once the child was
  // reaped or never spawned (Node's null-handle answer), and a successful
  // send sets `killed`.
  if (name === "kill") {
    if (call.arguments.nodes.length > 1) {
      lowerer.noLowering(`child.kill with ${call.arguments.nodes.length} arguments`, call);
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const sigNode = call.arguments.nodes[0];
    if (!sigNode) {
      const dflt: IrExpr = { kind: "strLit", value: "SIGTERM", type: STRING, loc };
      return { kind: "libCall", fn: "child.kill", args: [receiver, dflt], type: BOOL, loc };
    }
    const sig = lowerer.lowerExpr(sigNode);
    if (sig.type.kind === "f64") {
      return { kind: "libCall", fn: "child.killNum", args: [receiver, sig], type: BOOL, loc };
    }
    if (sig.type.kind === "string") {
      return { kind: "libCall", fn: "child.kill", args: [receiver, sig], type: BOOL, loc };
    }
    lowerer.noLowering(
      `child.kill with a '${lowerer.fmt(sig.type)}' signal`,
      sigNode,
      "pass a signal name string or number (narrow unions first)",
    );
  }
  // child.unref(): drops the child from the event loop's keep-alive set
  // (the process may exit while the child runs — Node's semantics; the
  // child is still reaped while the loop runs for other reasons).
  if ((name === "unref" || name === "ref") && call.arguments.nodes.length === 0) {
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: name === "ref" ? "child.ref" : "child.unref",
      args: [receiver],
      type: VOID,
      loc,
    };
  }
  lowerer.noLowering(
    `ChildProcess.${name}`,
    call,
    'send(), connected, disconnect(), on/once("message" | "disconnect" | "exit" | "close" | "error", cb), pid, exitCode, killed, kill(signal?), and unref() are supported',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on piped child-output stream receivers (child.stdout /
 * child.stderr — the childStream kind): on/once("data" | "end").
 * 'data' listeners take zero parameters, `(chunk: Buffer)`, `(chunk:
 * string)`, an unknown/any chunk (boxed as a checked-dynamic value; see
 * childStreamEncodedAt), or a `Buffer | string`-union chunk (the ngrok
 * appendOutput shape — the runtime only ever fires Buffers; the
 * compiler-emitted adapter wraps the chunk at the union's Buffer arm);
 * 'end' listeners take none.
 * Statement position only (Node returns the stream for chaining; here
 * the result is void). Chained receivers (`child.stdout?.on(...)`)
 * ride the optional-chain re-dispatch (chainBlocked). Everything else
 * @types/node declares on Readable fences member-qualified. Null for
 * non-stream receivers. */
export function lowerChildStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "childStream") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  if (name === "setEncoding" && call.arguments.nodes.length === 1) {
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDSTREAM_T);
    const enc = bufEncoding(lowerer, "child stream setEncoding", call.arguments.nodes[0]!);
    return {
      kind: "libCall",
      fn: "stream.childSetEncoding",
      args: [receiver, strLit(enc, loc)],
      type: CHILDSTREAM_T,
      loc,
    };
  }
  if ((name === "on" || name === "once") && call.arguments.nodes.length === 2) {
    const evT = lowerer.typeOf(call.arguments.nodes[0]!);
    const event = evT.isStringLiteralType() ? evT.value : null;
    if (event !== "data" && event !== "end") {
      requestGeneralStreamSurface(lowerer, access.expression);
      lowerer.noLowering(
        `stream.${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments.nodes[0]!,
        '"data" and "end" are the supported child-stream events (as literals)',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      requestGeneralStreamSurface(lowerer, access.expression);
      lowerer.unsupported(
        "SC1090",
        call,
        "chaining stream listener registration (the result is void here — register each listener as its own statement)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const cb = lowerer.lowerExpr(call.arguments.nodes[1]!);
    const once: IrExpr = { kind: "boolLit", value: name === "once", type: BOOL, loc };
    if (
      cb.type.kind !== "func" ||
      cb.type.ret.kind !== "void" ||
      cb.type.params.length > (event === "data" ? 1 : 0)
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        event === "data"
          ? "data listeners with more than one parameter or a return value (use (chunk) or ())"
          : "end listeners with parameters or a return value (use ())",
      );
    }
    if (event === "end") {
      return { kind: "libCall", fn: "stream.onEnd", args: [receiver, cb, once], type: VOID, loc };
    }
    const param = cb.type.params[0];
    const unionOk = (p: IrType): boolean => {
      if (p.kind !== "union") return false;
      const def = lowerer.unions.get(p.unionId);
      return !!def && def.arms.some((a) => a.kind === "bytes" && a.elem === "u8");
    };
    if (
      param !== undefined &&
      param.kind !== "string" &&
      param.kind !== "dyn" &&
      !(param.kind === "bytes" && param.elem === "u8") &&
      !unionOk(param)
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        `data listeners whose parameter is not 'Buffer', 'string', 'unknown', or a Buffer-armed union (got '${lowerer.fmt(param)}')`,
      );
    }
    // An unknown/any chunk is a Buffer, or a string once setEncoding ran.
    // The registration takes whichever the enclosing code establishes; a
    // later setEncoding that contradicts it throws the runtime's
    // listener-type TypeError instead of delivering the other kind.
    const strings =
      param?.kind === "string" ||
      (param?.kind === "dyn" && childStreamEncodedAt(lowerer, access.expression, call));
    return {
      kind: "libCall",
      fn: strings ? "stream.onDataStr" : "stream.onData",
      args: [receiver, cb, once],
      type: VOID,
      loc,
    };
  }
  requestGeneralStreamSurface(lowerer, access.expression);
  lowerer.noLowering(
    `ReadableStream.${name}`,
    call,
    'setEncoding(encoding) and on/once("data" | "end", cb) are the supported child-stream members',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Method calls on a piped child stdin writer. Writes copy one string or
 * Uint8Array into the nonblocking runtime queue and return the backpressure
 * signal. end()/destroy() are statement-only, as are drain/finish/error
 * listener registrations; unsupported callbacks/encodings stay fenced. */
export function lowerChildWriterMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (lowerer.chainBlocked(call, access)) return null;
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "childWriter") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  const loc = locOf(call);

  if (name === "write") {
    if (call.arguments.nodes.length !== 1 || call.arguments.nodes.some(ts.isSpreadElement)) {
      requestGeneralStreamSurface(lowerer, access.expression);
      lowerer.noLowering(
        `child stdin write with ${call.arguments.nodes.length} arguments`,
        call,
        "write(string | Uint8Array) with no encoding or callback is supported",
      );
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDWRITER_T);
    const data = lowerer.lowerExpr(call.arguments.nodes[0]!);
    if (data.type.kind === "string") {
      return { kind: "libCall", fn: "writer.writeString", args: [receiver, data], type: BOOL, loc };
    }
    if (data.type.kind === "bytes" && data.type.elem === "u8") {
      return { kind: "libCall", fn: "writer.writeBytes", args: [receiver, data], type: BOOL, loc };
    }
    lowerer.noLowering(
      `child stdin write of '${lowerer.fmt(data.type)}'`,
      call.arguments.nodes[0]!,
      "write one string, Buffer, or Uint8Array value (narrow unions first)",
    );
  }

  if ((name === "end" || name === "destroy") && call.arguments.nodes.length === 0) {
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported(
        "SC1090",
        call,
        `chaining child.stdin.${name}() (call it as its own statement)`,
      );
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDWRITER_T);
    return {
      kind: "libCall",
      fn: name === "end" ? "writer.end" : "writer.destroy",
      args: [receiver],
      type: VOID,
      loc,
    };
  }

  if ((name === "on" || name === "once") && call.arguments.nodes.length === 2) {
    const eventType = lowerer.typeOf(call.arguments.nodes[0]!);
    const event = eventType.isStringLiteralType() ? eventType.value : null;
    if (event !== "drain" && event !== "finish" && event !== "error") {
      requestGeneralStreamSurface(lowerer, access.expression);
      lowerer.noLowering(
        `child stdin ${name}(${event === null ? "non-literal event" : `"${event}"`}, ...)`,
        call.arguments.nodes[0]!,
        '"drain", "finish", and "error" are the supported child stdin events',
      );
    }
    if (!ts.isExpressionStatement(call.parent)) {
      lowerer.unsupported("SC1090", call, "chaining child stdin listener registration");
    }
    const receiver = lowerer.lowerExprExpecting(access.expression, CHILDWRITER_T);
    const cb = lowerer.lowerExpr(call.arguments.nodes[1]!);
    const maxParams = event === "error" ? 1 : 0;
    if (
      cb.type.kind !== "func" ||
      cb.type.ret.kind !== "void" ||
      cb.type.params.length > maxParams
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        event === "error"
          ? "error listeners with at most one Error parameter and no return value"
          : `${event} listeners with no parameters or return value`,
      );
    }
    if (
      event === "error" &&
      cb.type.params[0] !== undefined &&
      !(cb.type.params[0]!.kind === "object" && cb.type.params[0]!.className === "%Error")
    ) {
      lowerer.unsupported(
        "SC1090",
        call.arguments.nodes[1]!,
        "child stdin error listeners whose parameter is Error",
      );
    }
    const once = boolLit(name === "once", loc);
    const fn =
      event === "drain"
        ? "writer.onDrain"
        : event === "finish"
          ? "writer.onFinish"
          : "writer.onError";
    return { kind: "libCall", fn, args: [receiver, cb, once], type: VOID, loc };
  }

  requestGeneralStreamSurface(lowerer, access.expression);
  lowerer.noLowering(
    `Writable.${name}`,
    call,
    'write(string | Uint8Array), end(), destroy(), and on/once("drain" | "finish" | "error", cb) are supported',
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** A receiver spelled as a plain access path (`child.stdout`, `out`): its
 * root symbol and member names, or null for other forms. A `const` alias
 * of an access path (`const out = child.stdout`) resolves to that path,
 * and so does a method call declared to return `this`
 * (`child.stdout.setEncoding("utf8")`), so every spelling of one stream
 * gets the same key. */
function accessPathOf(
  lowerer: Lowerer,
  expr: ts.Expression,
  depth = 0,
): { root: ts.Symbol; path: string } | null {
  if (depth > 16) return null;
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) {
    return accessPathOf(lowerer, expr.expression, depth + 1);
  }
  if (ts.isIdentifier(expr)) {
    const root = lowerer.checker.getSymbolAtLocation(expr);
    if (!root) return null;
    const init = constInitializerOf(root);
    const aliased = init === null ? null : accessPathOf(lowerer, init, depth + 1);
    return aliased ?? { root, path: "" };
  }
  if (ts.isPropertyAccessExpression(expr) && !expr.questionDotToken) {
    const base = accessPathOf(lowerer, expr.expression, depth + 1);
    return base === null ? null : { root: base.root, path: `${base.path}.${expr.name.text}` };
  }
  if (returnsReceiver(lowerer, expr)) {
    return accessPathOf(
      lowerer,
      (expr.expression as ts.PropertyAccessExpression).expression,
      depth + 1,
    );
  }
  return null;
}

/** A method call (`recv.m(...)`, not optional) whose declaration returns
 * `this`, so its value is the receiver itself. */
function returnsReceiver(lowerer: Lowerer, expr: ts.Expression): expr is ts.CallExpression {
  if (
    !ts.isCallExpression(expr) ||
    expr.questionDotToken ||
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.questionDotToken
  )
    return false;
  const declaration = lowerer.checker.getResolvedSignature(expr)?.declaration;
  return declaration?.type?.kind === ts.SyntaxKind.ThisType;
}

/** A call of a child_process factory (spawn, fork, exec, execFile), each
 * of which returns a new ChildProcess. */
function createsChildProcess(lowerer: Lowerer, call: ts.CallExpression): boolean {
  const declaration = lowerer.checker.getResolvedSignature(call)?.declaration;
  if (
    declaration === undefined ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.name === undefined ||
    !["spawn", "fork", "exec", "execFile"].includes(declaration.name.text)
  )
    return false;
  for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent) {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      return node.name.text === "child_process" || node.name.text === "node:child_process";
    }
  }
  return false;
}

/** The statement that always evaluates `call` when it runs: the call is
 * the statement's expression, a variable's initializer, or the receiver of
 * a method chain that is one of those. Null for calls under a condition,
 * an operator, an argument list or any other construct. */
function unconditionalStatementOf(call: ts.CallExpression): ts.Statement | null {
  let node: ts.Node = call;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return null;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      (ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        !parent.questionDotToken) ||
      (ts.isCallExpression(parent) && parent.expression === node && !parent.questionDotToken)
    ) {
      node = parent;
      continue;
    }
    if (ts.isExpressionStatement(parent)) return parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
      const list = parent.parent;
      const statement = list?.parent;
      return list !== undefined &&
        ts.isVariableDeclarationList(list) &&
        statement !== undefined &&
        ts.isVariableStatement(statement)
        ? statement
        : null;
    }
    return null;
  }
}

/** The initializer of a symbol declared once as a `const` variable, else null. */
function constInitializerOf(symbol: ts.Symbol): ts.Expression | null {
  const decls = symbol.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0]!;
  if (
    !ts.isVariableDeclaration(decl) ||
    !ts.isIdentifier(decl.name) ||
    decl.initializer === undefined ||
    (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0
  )
    return null;
  return decl.initializer;
}

/** Whether two resolved access paths name different objects: the same root
 * with different members, or two `const` roots each initialized by `new`
 * or a child_process factory (such as two `spawn()` results). Any other
 * call may return an object another binding already holds. */
function distinctPaths(
  lowerer: Lowerer,
  a: { root: ts.Symbol; path: string },
  b: { root: ts.Symbol; path: string },
): boolean {
  if (a.root === b.root) return a.path !== b.path;
  const fresh = (root: ts.Symbol): boolean => {
    let init = constInitializerOf(root);
    while (init !== null && ts.isParenthesizedExpression(init)) init = init.expression;
    if (init === null) return false;
    return (
      ts.isNewExpression(init) || (ts.isCallExpression(init) && createsChildProcess(lowerer, init))
    );
  };
  return fresh(a.root) && fresh(b.root);
}

/** Whether an unknown-typed 'data' listener registered by `call` receives
 * strings: a `setEncoding` statement on the same receiver path precedes
 * the registration in its own block or an enclosing block of the same
 * function. With no setEncoding on that path in the function, chunks are
 * Buffers. Any other placement leaves the encoding state unclear, which
 * is reported. */
function childStreamEncodedAt(
  lowerer: Lowerer,
  receiver: ts.Expression,
  call: ts.CallExpression,
): boolean {
  const key = accessPathOf(lowerer, receiver);
  const statement: ts.Node = call.parent!;
  let scope: ts.Node | undefined = statement;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  const unclear = (): never =>
    lowerer.unsupported(
      "SC1090",
      call.arguments.nodes[1]!,
      "untyped child-stream 'data' listeners whose setEncoding state is unclear at their registration sites (declare the chunk as 'Buffer' or 'string')",
    );
  if (key === null || scope === undefined) return unclear();
  const preceding = new Set<ts.Node>();
  for (let node: ts.Node = statement; node !== scope;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) break;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const sibling of parent.statements.nodes) {
        if (sibling === node) break;
        preceding.add(sibling);
      }
    }
    node = parent;
  }
  const receiverType = lowerer.checker.getNonNullableType(lowerer.typeOf(receiver));
  let before = false;
  let elsewhere = false;
  const visit = (node: ts.Node): void => {
    if (node !== scope && ts.isFunctionLike(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "setEncoding"
    ) {
      const target = node.expression.expression;
      const path = accessPathOf(lowerer, target);
      if (path !== null && path.root === key.root && path.path === key.path) {
        const statement = unconditionalStatementOf(node);
        if (statement !== null && preceding.has(statement)) before = true;
        else elsewhere = true;
      } else if (
        (path === null || !distinctPaths(lowerer, path, key)) &&
        lowerer.checker.isTypeAssignableTo(receiverType, lowerer.typeOf(target))
      ) {
        // Another spelling that can hold this stream (a parameter, a `let`
        // copy, a call result): its setEncoding may be this stream's.
        elsewhere = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  if (elsewhere) return unclear();
  return before;
}

/** An inline 'exit'/'close' listener may declare `(code: number, signal:
 * string)`: TypeScript accepts it through ChildProcess's catch-all `on`
 * overload, while Node passes `number | null` and `Signals | null`. Those
 * parameters bind as checked-dynamic values (the socket 'data' listener
 * precedent), so the body observes the null Node passes; a typed use of a
 * null value throws the checked conversion's TypeError. Returns the
 * narrowed parameter symbols, empty when the declared types already
 * admit null. */
function narrowedExitListenerParams(lowerer: Lowerer, listener: ts.Expression): ts.Symbol[] {
  if (!ts.isArrowFunction(listener) && !ts.isFunctionExpression(listener)) return [];
  if (isJsSourceFile(ts.getSourceFileOfNode(listener))) return [];
  const symbols: ts.Symbol[] = [];
  const wanted: readonly string[] = ["f64", "string"];
  listener.parameters.nodes.slice(0, 2).forEach((param, i) => {
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer) return;
    if (param.questionToken) return;
    const symbol = lowerer.checker.getSymbolAtLocation(param.name);
    if (!symbol || lowerer.runtimeOptionalBindingTypes.has(symbol)) return;
    if (lowerer.paramShape(param).type.kind !== wanted[i]) return;
    symbols.push(symbol);
  });
  return symbols;
}

/** Lowers an inline listener with the given parameters bound as
 * checked-dynamic values typed `unknown` for the body. */
function lowerWithCheckedParams(
  lowerer: Lowerer,
  listener: ts.Expression,
  symbols: readonly ts.Symbol[],
): IrExpr {
  const previousImplicit = lowerer.implicitParamTypes;
  const implicit = new Map(previousImplicit ?? []);
  for (const symbol of symbols) {
    implicit.set(symbol, lowerer.checker.getUnknownType());
    lowerer.runtimeOptionalBindingTypes.set(symbol, DYN);
  }
  lowerer.implicitParamTypes = implicit;
  try {
    return lowerer.lowerExpr(listener);
  } finally {
    for (const symbol of symbols) lowerer.runtimeOptionalBindingTypes.delete(symbol);
    lowerer.implicitParamTypes = previousImplicit;
  }
}
