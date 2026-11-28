import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The websocket builtin call slots. */
export const websocketSignatures = defineLibFnSignatures({
  /** new WebSocket(url[, protocols]): both arguments are checked-dynamic
   * (the URL coerces, the protocols take a string or a string array), and
   * the runtime validates them as Node does (MAY THROW). */
  "websocket.new": { argTypes: [DYN, DYN], result: DYN },
  /** `value instanceof WebSocket`: the handle tag test. */
  "websocket.is": { argTypes: [DYN], result: BOOL },
});
