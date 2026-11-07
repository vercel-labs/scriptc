// A function that answers a builtin module namespace still runs when a
// guarded member reads through it. `loadOs()?.arch()` calls loadOs first:
// its side effects happen in source order, and an exception it throws is
// not skipped. The member itself answers statically (the namespace is
// never nullish), so only the receiver's evaluation can be observed.
import * as os from "node:os";
import type * as NodeOs from "node:os";

let calls = 0;
function loadOs(): typeof NodeOs {
  calls++;
  console.log("load", calls);
  return os;
}

console.log(loadOs()?.arch() === os.arch(), calls);
console.log(loadOs()?.EOL === os.EOL, calls);
// The call's answer decides the member read, as in Node: the chain is
// not skipped because the namespace cannot be nullish.
const arch = loadOs()?.arch();
console.log(typeof arch === "string", arch === os.arch(), calls);

function refuse(): typeof NodeOs {
  calls++;
  console.log("refuse", calls);
  throw new Error("refused");
}
try {
  refuse()?.arch();
  console.log("not reached");
} catch (error) {
  console.log("caught", (error as Error).message, calls);
}

// A namespace import directly needs no evaluation at all.
console.log(os?.arch() === os.arch(), calls);
