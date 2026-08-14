// node:midi lowering boundaries: what stays rejected at LOWERING with
// specific messages. The fallback declarations type the port surface
// exactly, so most misuse (a "clock" event, a string sendMessage, a wrong
// listener arity) is a type error before lowering; these are the forms that
// TYPECHECK and fence per site — the SC2020 lib fence for a message shape no
// marshaler lowers, and the SC1090 statement-position rule the dgram spoke
// shares. Each site is its own statement so all four diagnostics collect.

import { Input, Output } from "midi";

const output = new Output();

// The static type calls this a number[], but the runtime shape is a string:
// only a cast reaches the byte-transparent marshaler fence (a number[] rides
// sendArray, a Uint8Array rides sendBytes, and nothing else lowers).
output.sendMessage("nope" as unknown as number[]);

const input = new Input();

// Port calls return void — Node returns void here too — so their result
// cannot feed a binding; call them as their own statement.
const opened = input.openPort(0);

// A message listener is called as void; an ANNOTATED value-returning arrow
// keeps its word and stays fenced (the child_process listener rule exactly).
input.on("message", (deltaTime): number => deltaTime);

// A void-result port call in argument position is not a statement either.
console.log(input.closePort());
