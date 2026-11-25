// @requires-libnode
// Identity of a native AbortSignal across a Node island: every crossing of
// one signal meets the same island object (a Map keyed by it hits, a
// listener added in one call is removed in another), two signals are two
// objects, and a signal coming back from the island is the program's own.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface Options {
  signal: AbortSignal;
}

const first = new AbortController();
const second = new AbortController();

console.log(lib.remember(first.signal, "first"));
console.log(lib.remember(second.signal, "second"));
console.log(lib.remember(first.signal, "first again"));
console.log(lib.recall(first.signal), "|", lib.recall(second.signal));

console.log("kept", lib.keep(first.signal), lib.keep(first.signal), lib.keep(second.signal));
const options: Options = { signal: second.signal };
console.log("through a record", lib.fromOptions(options));

// Coming back: the program's own signal, not a handle to the island's.
const back: AbortSignal = lib.back(first.signal);
console.log("back", back === first.signal, back === second.signal, back.aborted);
const kept: AbortSignal = lib.kept();
console.log("kept back", kept === second.signal);
const wrapped = lib.wrap(first.signal);
const inner: AbortSignal = wrapped.signal;
const listed: AbortSignal = wrapped.list[1];
console.log("wrapped", inner === first.signal, listed === first.signal);

// A listener the island adds in one call and removes in another.
console.log("listen", lib.listen(first.signal, "a"), lib.listen(first.signal, "b"));
console.log("unlisten", lib.unlisten(first.signal, "a"));
first.abort("done");
console.log("after", lib.recall(first.signal), lib.back(first.signal) === first.signal);

// The returned signal is the native one: a native listener added to it
// runs when the program's controller aborts.
kept.addEventListener("abort", () => console.log("native listener on the returned signal"));
second.abort();
console.log("second", lib.recall(second.signal), second.signal.aborted);
