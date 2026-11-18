import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, DYN, F64, type IrExpr } from "../../../ir/ir.js";
import { dynUndefinedExpr } from "../../../ir/build.js";

/* The global WebSocket client. Node 24's global is WHATWG's WebSocket over
 * a native connect: the constructor validates its URL and subprotocols, the
 * handshake upgrades an HTTP/1.1 connection, and the connection carries
 * RFC 6455 frames. The value is a checked-dynamic handle (the runtime's
 * scr_websocket.c) whose members the dynamic tier answers, so the lowering
 * covers construction, the readyState constants and instanceof; the handle's
 * EventTarget side (`addEventListener`, the `onopen`/`onmessage`/`onerror`/
 * `onclose` attributes, `send`, `close`, `readyState`, `url`, `protocol`,
 * `extensions`, `bufferedAmount`, `binaryType`) dispatches at run time. */

/** Whether `node` names the standard library's WebSocket global. */
export function isWebSocketGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  return lowerer.isStdlibGlobal(node, "WebSocket");
}

/** Node's WebSocket readyState constants, which are static properties of
 * the constructor (`WebSocket.OPEN` etc.). */
const READY_STATES: Record<string, number | undefined> = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

/** Property READS on THE `WebSocket` global: the readyState constants bake
 * as number literals. Every other member read keeps its own lowering or its
 * fence. Null for non-WebSocket receivers. */
export function lowerWebSocketStaticProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = lowerer.stdlibGlobalMember(expr, "WebSocket");
  if (member === null) return null;
  const value = READY_STATES[member];
  if (value === undefined) return null;
  return { kind: "numLit", value, type: F64, loc: locOf(expr) };
}

/** `value instanceof WebSocket`, or null when the right side is something
 * else. Both operands evaluate left to right; the left value reaches the
 * runtime as a checked-dynamic value, and only a WebSocket handle answers
 * true — the prototype walk Node's interface instances take. */
export function lowerWebSocketInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isWebSocketGlobal(lowerer, expr.right)) return null;
  const loc = locOf(expr);
  return {
    kind: "libCall",
    fn: "websocket.is",
    args: [lowerer.lowerExprExpecting(expr.left, DYN)],
    type: BOOL,
    loc,
  };
}

/** `new WebSocket(url[, protocols])`: both arguments evaluate in source
 * order and reach the runtime as checked-dynamic values, which coerce and
 * validate them as Node does (a bad URL, scheme, fragment or subprotocol
 * value throws a catchable SyntaxError DOMException; the handshake itself is
 * asynchronous and reports through the object's events). */
export function lowerWebSocketNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isWebSocketGlobal(lowerer, expr.expression)) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 2 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `WebSocket constructor with ${args.length} arguments`,
      expr,
      "use new WebSocket(url[, protocols])",
    );
  }
  const loc = locOf(expr);
  const url =
    args[0] === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(args[0], DYN);
  const protocols =
    args[1] === undefined ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(args[1], DYN);
  return { kind: "libCall", fn: "websocket.new", args: [url, protocols], type: DYN, loc };
}
