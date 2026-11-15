// @requires-libnode
// A native AbortController handed to a Node island is a real
// AbortController there whose signal is the island's twin of the program's
// signal. Aborting it from the island aborts the program's controller: the
// native listeners run and both sides read the same state and reason.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

const first = new AbortController();
console.log("brand", lib.describe(first));
console.log("same signal", lib.sameSignal(first, first.signal));
console.log("kept", lib.keep(first), lib.keep(first));
first.signal.addEventListener("abort", () =>
  console.log("native listener", first.signal.aborted, String(first.signal.reason)),
);
console.log("abort from the island", lib.abortKept("island says stop"));
console.log("native state", first.signal.aborted, first.signal.reason);
// Aborting again, from either side, changes nothing.
console.log("again", lib.abortKept("twice"));
first.abort("thrice");
console.log("still", lib.state(first.signal), first.signal.reason);

// Aborted from the island with no reason: the default AbortError.
const second = new AbortController();
lib.keep(second);
second.signal.addEventListener("abort", () => {
  const reason = second.signal.reason as Error;
  console.log("native listener", reason.name, reason.message);
});
console.log("default", lib.abortKept());

// The signal crossed first, the controller later: still one pair.
const third = new AbortController();
console.log("signal first", lib.state(third.signal), lib.sameSignal(third, third.signal));
// Aborted from the island with an object the island made: the program
// holds that object, and it is the same object back on the island.
console.log("object reason", lib.abortWithObject(third), third.signal.aborted);
console.log("round trip", lib.isKeptReason(third.signal.reason));

// The controller coming back is the program's own.
const back: AbortController = lib.back(first);
console.log("back", back === first, back.signal === first.signal);

// A controller the program aborts after it crossed: the island's signal follows.
const fourth = new AbortController();
lib.keep(fourth);
fourth.abort(new Error("from the program"));
console.log("followed", lib.state(fourth.signal));
