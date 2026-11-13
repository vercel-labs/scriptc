import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
} from "../../../ir/ir.js";
import { dynUndefinedExpr, nodeThrowExpr } from "../../../ir/build.js";
import { resultIsDiscarded } from "../call-position.js";
import { processHasIpc } from "./process.js";

/** Method calls on ChildProcess receivers: `child.on("exit"|"error", cb)`
 * registers a listener with the event loop's child registry. The event
 * name must be one of the two terminal-event LITERALS; the callback
 * takes at most one parameter — `(code: number | null)` for exit (the
 * signal parameter has no lowering), `(err: Error)` for error — or none.
 * `on` is statement-only (Node returns the child for chaining; here the
 * result is void and chaining is fenced). kill(signal?) and unref()
 * lower too (the property reads — pid/exitCode/killed — live in
 * lowerIntrinsicProperty). Everything else @types/node declares on
 * ChildProcess (stdout, once, ...) fences member-qualified. Null for
 * non-child receivers. */
function ignoredListenerReturn(type: IrType): boolean {
  return type.kind === "void" || (type.kind === "promise" && type.inner.kind === "void");
}

export function ipcJsonMessage(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (!lowerer.jsonStringifySafe(value.type) && value.type.kind !== "dyn") {
    lowerer.unsupported(
      "SC1090",
      node,
      `IPC messages of '${lowerer.fmt(value.type)}' values (messages must be JSON-stringifiable records, arrays, primitives, unions of those, or unknown)`,
    );
  }
  return { kind: "jsonStringify", value, type: STRING, loc };
}

export function ipcMessageListener(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func" || cb.type.params.length > 2 || !ignoredListenerReturn(cb.type.ret)) {
    lowerer.unsupported(
      "SC1090",
      node,
      "message listeners take at most Node's two parameters, (message, sendHandle), and may return void or Promise<void>",
    );
  }
  const param = cb.type.params[0];
  if (param !== undefined && param.kind !== "dyn" && !lowerer.jsonSafe(param)) {
    lowerer.unsupported(
      "SC1090",
      node,
      `message listeners whose parameter is not JSON-shaped or unknown (got '${lowerer.fmt(param)}')`,
    );
  }
  // Node's second parameter, the handle sent along with the message. Handle
  // transfer has no lowering, so the listener is always handed undefined;
  // the parameter must be able to hold it, which only an untyped one does.
  const handle = cb.type.params[1];
  if (handle !== undefined && handle.kind !== "dyn") {
    lowerer.unsupported(
      "SC1090",
      node,
      `message listeners whose sendHandle parameter is not 'any' (got '${lowerer.fmt(handle)}'); handle transfer is not lowered, so Node hands the listener undefined`,
    );
  }
  return cb;
}

export function ipcDisconnectListener(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func" || cb.type.params.length !== 0 || cb.type.ret.kind !== "void") {
    lowerer.unsupported("SC1090", node, "disconnect listeners take no parameters and return void");
  }
  return cb;
}

/** Node's send arguments: `send(message[, sendHandle[, options]][, callback])`.
 * A function in the sendHandle or options slot IS the callback, as Node's
 * own argument shuffling decides it. A sendHandle has no lowering (the
 * child side would need the transferred socket), so only a nullish one is
 * accepted; `options.keepOpen` is consulted only when a handle is sent, so
 * a literal options record is accepted and has no effect without one. */
export function ipcSendArguments(
  lowerer: Lowerer,
  call: ts.CallExpression,
  loc: SrcLoc,
): { json: IrExpr; callback: IrExpr | null } {
  const args = call.arguments.nodes;
  if (args.length < 1 || args.length > 4 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `send with ${args.length} arguments`,
      call,
      "send(message[, sendHandle[, options]][, callback]) is supported; a sendHandle must be null or undefined, because handle transfer is not lowered",
    );
  }
  const isCallback = (node: ts.Expression): boolean =>
    lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "func";
  let sendHandle: ts.Expression | undefined;
  let options: ts.Expression | undefined;
  let callbackNode: ts.Expression | undefined;
  if (args[1] !== undefined) {
    if (isCallback(args[1])) callbackNode = args[1];
    else {
      sendHandle = args[1];
      if (args[2] !== undefined) {
        if (isCallback(args[2])) callbackNode = args[2];
        else options = args[2];
      }
      if (args[3] !== undefined) {
        if (options === undefined) {
          lowerer.noLowering(
            "send with four arguments and no options record",
            call,
            "the third argument after the message is the options record, the fourth the callback",
          );
        }
        callbackNode = args[3];
      }
    }
  }
  if (sendHandle !== undefined) {
    const type = lowerer.mapTypeOf(lowerer.typeOf(sendHandle));
    const nullish =
      type?.kind === "nullT" ||
      type?.kind === "undefinedT" ||
      (type?.kind === "union" &&
        (lowerer.unions.get(type.unionId)?.arms ?? []).every(
          (arm) => arm.kind === "nullT" || arm.kind === "undefinedT",
        ));
    if (!nullish) {
      lowerer.noLowering(
        "send with a sendHandle",
        sendHandle,
        "handle transfer (a net.Socket, net.Server or dgram.Socket sent over the channel) is not lowered; pass null or undefined",
      );
    }
  }
  if (options !== undefined) {
    // An explicit nullish options value is an absent one, as in Node.
    const optionType = lowerer.mapTypeOf(lowerer.typeOf(options));
    if (optionType?.kind === "nullT" || optionType?.kind === "undefinedT") options = undefined;
  }
  if (options !== undefined) {
    if (!ts.isObjectLiteralExpression(options)) {
      lowerer.noLowering(
        "send with a non-literal options value",
        options,
        "write { keepOpen: true } or { keepOpen: false } inline",
      );
    }
    for (const property of options.properties.nodes) {
      const keepOpen =
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === "keepOpen") ||
          (ts.isStringLiteral(property.name) && property.name.text === "keepOpen"));
      if (!keepOpen) {
        lowerer.noLowering(
          "send with this options shape",
          property,
          "keepOpen is send's only option, and it only matters when a handle is sent",
        );
      }
    }
  }
  const callback = callbackNode === undefined ? null : ipcSendCallback(lowerer, callbackNode);
  return { json: ipcJsonMessage(lowerer, args[0]!, loc), callback };
}

export function ipcSendCallback(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const cb = lowerer.lowerExpr(node);
  if (cb.type.kind !== "func" || cb.type.params.length > 1 || cb.type.ret.kind !== "void") {
    lowerer.unsupported(
      "SC1090",
      node,
      "send callbacks take () or (error: Error | null) and return void",
    );
  }
  const param = cb.type.params[0];
  if (param !== undefined) {
    const def = param.kind === "union" ? lowerer.unions.get(param.unionId) : undefined;
    const valid =
      !!def &&
      def.arms.length === 2 &&
      def.arms.some((arm) => arm.kind === "nullT") &&
      def.arms.some((arm) => arm.kind === "object" && arm.className === "%Error");
    if (!valid) {
      lowerer.unsupported(
        "SC1090",
        node,
        `send callbacks whose parameter is not 'Error | null' (got '${lowerer.fmt(param)}')`,
      );
    }
  }
  return cb;
}

/** process.send in a program without fork targets. This binary never opens
 * a channel then, so only a Node.js parent's NODE_CHANNEL_FD can define
 * process.send, and that channel has no lowering: a call fences when it runs.
 * Without any channel the calls behave as Node's do on an undefined member:
 * `process.send?.(...)` skips its arguments and answers undefined, and
 * `process.send(...)` evaluates them and throws a TypeError. The message is
 * never sent, so its type is not checked. */
function lowerChannelLessSend(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  const loc = locOf(call);
  const fence = (type: IrType): IrExpr =>
    nodeThrowExpr(
      0,
      "SC2020",
      "process.send over an IPC channel opened by a Node.js parent (NODE_CHANNEL_FD) is not supported yet",
      type,
      loc,
    );
  const hasIpc = processHasIpc(lowerer, loc);
  if (call.questionDotToken) {
    const type = lowerer.mapTypeOf(lowerer.typeOf(call)) ?? BOOL;
    const absent: IrExpr =
      type.kind === "bool"
        ? { kind: "boolLit", value: false, type: BOOL, loc }
        : lowerer.coerceToExpected(
            { kind: "unitLit", unit: "undefined", type: UNDEFINED_T, loc },
            type,
          );
    return { kind: "ternary", cond: hasIpc, then: fence(type), else_: absent, type, loc };
  }
  const stmts: IrStmt[] = call.arguments.nodes.map((arg) => ({
    kind: "exprStmt",
    expr: lowerer.lowerExpr(ts.isSpreadElement(arg) ? arg.expression : arg),
    loc: locOf(arg),
  }));
  const result: IrExpr = {
    kind: "ternary",
    cond: hasIpc,
    then: fence(BOOL),
    else_: nodeThrowExpr(1, "", "process.send is not a function", BOOL, loc),
    type: BOOL,
    loc,
  };
  return stmts.length === 0 ? result : { kind: "seqExpr", stmts, result, type: BOOL, loc };
}

/** process.disconnect(), process.disconnect!() and process.disconnect?.().
 * Node defines the method only in a process that has an IPC channel, as it
 * does process.send: without one the call throws Node's TypeError for an
 * undefined member, and the optional call answers undefined. A fork child
 * closes the channel it opened; the channel a Node.js parent opened
 * (NODE_CHANNEL_FD) has no lowering and fences when the call runs. */
export function lowerProcessIpcDisconnect(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  const loc = locOf(call);
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(`process.disconnect with ${call.arguments.nodes.length} arguments`, call);
  }
  if (!resultIsDiscarded(call)) {
    lowerer.unsupported(
      "SC1090",
      call,
      "using the result of process.disconnect() (call it as its own statement)",
    );
  }
  const present: IrExpr =
    lowerer.forkTargets.length === 0
      ? nodeThrowExpr(
          0,
          "SC2020",
          "process.disconnect over an IPC channel opened by a Node.js parent (NODE_CHANNEL_FD) is not supported yet",
          VOID,
          loc,
        )
      : { kind: "libCall", fn: "process.disconnect", args: [], type: VOID, loc };
  const absent: IrStmt[] | null = call.questionDotToken
    ? null
    : [
        {
          kind: "exprStmt",
          expr: nodeThrowExpr(1, "", "process.disconnect is not a function", VOID, loc),
          loc,
        },
      ];
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "if",
        cond: processHasIpc(lowerer, loc),
        then: [{ kind: "exprStmt", expr: present, loc }],
        else_: absent,
        loc,
      },
    ],
    result: dynUndefinedExpr(loc),
    type: DYN,
    loc,
  };
}

export function lowerProcessIpcSend(lowerer: Lowerer, call: ts.CallExpression): IrExpr {
  const loc = locOf(call);
  if (lowerer.forkTargets.length === 0) return lowerChannelLessSend(lowerer, call);
  const { json, callback } = ipcSendArguments(lowerer, call, loc);
  if (callback === null) {
    return { kind: "libCall", fn: "process.send", args: [json], type: BOOL, loc };
  }
  return { kind: "libCall", fn: "process.sendCb", args: [json, callback], type: BOOL, loc };
}
