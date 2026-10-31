import * as ts from "../../ts7/adapter.js";

const LISTENER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/** `<x>.on("message", …)` and the other listener registrations. */
export function isMessageListenerCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const event = call.arguments.nodes[0];
  return (
    ts.isPropertyAccessExpression(callee) &&
    LISTENER_METHODS.has(callee.name.text) &&
    event !== undefined &&
    ts.isStringLiteral(event) &&
    event.text === "message"
  );
}
