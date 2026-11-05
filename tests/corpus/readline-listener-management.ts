// node:readline's listener management: an interface starts with Node's own
// once('close') listener, which eventNames() lists first and
// listenerCount('close') counts, but a listener's removeListener never
// matches. removeListener and off remove the LAST registration of the same
// function (a once registration leaves as the function itself), listenerCount
// counts an event's listeners (with a function, only that function's),
// removeAllListeners drops one event's listeners or all of them (the
// interface's own close listener too), and every member answers the interface
// so calls chain.
import * as readline from "node:readline";
import { PassThrough } from "node:stream";

const input = new PassThrough();
const rl = readline.createInterface({ input, terminal: false });

console.log("names at start", JSON.stringify(rl.eventNames()));
console.log("close count at start", rl.listenerCount("close"));

const lines: string[] = [];
function a(line: string): void {
  lines.push("a:" + line);
}
const b = (line: string): void => {
  lines.push("b:" + line);
};

console.log("chain", rl.on("line", a).on("line", b) === rl);
rl.on("line", a);
console.log("count", rl.listenerCount("line"));
console.log("count a", rl.listenerCount("line", a));
console.log("count b", rl.listenerCount("line", b));
console.log("count other", rl.listenerCount("line", (line: string) => void line));

rl.removeListener("line", a);
console.log("after remove a", rl.listenerCount("line"), rl.listenerCount("line", a));
rl.off("line", b);
console.log("after off b", rl.listenerCount("line"), rl.listenerCount("line", b));
rl.removeListener("line", b);
console.log("after remove unknown", rl.listenerCount("line"));

// A listener's return value is ignored, and the function is still the same
// function to remove by.
const returns = (line: string): number => lines.length + line.length;
rl.on("line", returns);
console.log("returns count", rl.listenerCount("line", returns));
rl.removeListener("line", returns);
console.log("returns removed", rl.listenerCount("line", returns));

const onceLine = (line: string): void => {
  lines.push("once:" + line);
};
rl.once("line", onceLine);
console.log("once count", rl.listenerCount("line"), rl.listenerCount("line", onceLine));
rl.removeListener("line", onceLine);
console.log("once removed", rl.listenerCount("line"));

rl.on("error", () => console.log("error"));
rl.on("pause", () => console.log("paused"));
console.log("names", JSON.stringify(rl.eventNames()));

rl.on("close", () => {
  console.log("close count at close", rl.listenerCount("close"));
  console.log("names at close", JSON.stringify(rl.eventNames()));
});

rl.removeAllListeners("pause");
console.log("names after offAll pause", JSON.stringify(rl.eventNames()));
rl.removeAllListeners("error");
rl.removeAllListeners("close");
console.log("names after offAll close", JSON.stringify(rl.eventNames()));
console.log("close count after offAll close", rl.listenerCount("close"));
rl.on("close", () => console.log("user close after offAll"));
console.log("names after re-add", JSON.stringify(rl.eventNames()));

rl.removeAllListeners();
console.log("names after offAll", JSON.stringify(rl.eventNames()));
console.log("counts after offAll", rl.listenerCount("line"), rl.listenerCount("close"));

rl.on("line", a);
rl.on("close", () => {
  console.log("lines", JSON.stringify(lines));
  console.log("counts at close", rl.listenerCount("line"), rl.listenerCount("close"));
});
input.write("one\n");
input.write("two\n");
input.end();
