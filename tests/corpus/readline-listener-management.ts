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

// An event whose last once-listener fires leaves the eventNames() order
// (Node deletes the emptied key), so the next registration goes to the end,
// behind the events registered in the meantime.
const ordering = new PassThrough();
const ordered = readline.createInterface({ input: ordering, terminal: false });
ordered.once("line", (line: string) => console.log("ordered once", line));
ordered.on("pause", () => console.log("ordered pause"));
ordered.on("resume", () => console.log("ordered resume"));
console.log("order before", JSON.stringify(ordered.eventNames()));
ordered.write("first\n");
console.log("order after once", JSON.stringify(ordered.eventNames()));
ordered.on("line", (line: string) => console.log("ordered line", line));
console.log("order after re-add", JSON.stringify(ordered.eventNames()));
ordered.write("second\n");
ordered.close();

// removeAllListeners removes everything only for the NO-argument call; an
// explicit undefined (or null, which Node keys as "null") names an event no
// interface registers, so it leaves the listeners in place.
const nothing: undefined = undefined;
const kept = (): void => void 0;
ordered.on("line", kept);
ordered.on("pause", kept);
console.log(
  "offAll undefined",
  ordered.removeAllListeners(nothing) === ordered,
  ordered.listenerCount("line"),
  ordered.listenerCount("pause"),
);
// The argument still evaluates even when it names no event: Node runs an
// expression typed undefined (or null) for its side effects and its throws.
let evaluated = 0;
const undefinedCall = (): undefined => {
  evaluated += 1;
  return undefined;
};
const nullCall = (): null => {
  evaluated += 1;
  return null;
};
console.log(
  "offAll undefined call",
  ordered.removeAllListeners(undefinedCall()) === ordered,
  evaluated,
  ordered.listenerCount("line"),
  ordered.listenerCount("pause"),
);
console.log(
  "offAll null call",
  ordered.removeAllListeners(nullCall() as unknown as undefined) === ordered,
  evaluated,
  ordered.listenerCount("line"),
  ordered.listenerCount("pause"),
);
try {
  const throws = (): undefined => {
    throw new Error("removeAllListeners argument");
  };
  ordered.removeAllListeners(throws());
  console.log("offAll throwing argument", "no throw");
} catch (err) {
  console.log("offAll throwing argument", (err as Error).message);
}
console.log(
  "offAll after throws",
  ordered.listenerCount("line"),
  ordered.listenerCount("pause"),
);
console.log(
  "offAll null",
  ordered.removeAllListeners(null as unknown as undefined) === ordered,
  ordered.listenerCount("line"),
  ordered.listenerCount("pause"),
);
ordered.removeAllListeners();
console.log(
  "offAll none",
  ordered.listenerCount("line"),
  ordered.listenerCount("pause"),
  ordered.listenerCount("close"),
);

// The signal option adds Node's second close listener, the one that
// disposes the abort listener; an already-aborted signal adds none and
// closes the interface on the next tick instead.
const live = new AbortController();
const watched = readline.createInterface({
  input: new PassThrough(),
  terminal: false,
  signal: live.signal,
});
console.log("signal count", watched.listenerCount("close"));
watched.removeAllListeners("close");
console.log("signal after offAll", watched.listenerCount("close"));
watched.close();

const aborted = new AbortController();
aborted.abort();
const abortedRl = readline.createInterface({
  input: new PassThrough(),
  terminal: false,
  signal: aborted.signal,
});
console.log("aborted count", abortedRl.listenerCount("close"));
