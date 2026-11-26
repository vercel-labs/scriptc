// rawListeners answers Node's list: a plain listener is the function that was
// registered, and a once() registration is the wrapper Node registers — named
// "wrapper", carrying the original as .listener, and removing the registration
// (then running the original) when called directly. getEventListeners answers
// the same raw list.
const { EventEmitter, getEventListeners } = require("node:events");

const e = new EventEmitter();
const orig = () => {};
const plain = () => {};
e.once("x", orig);
e.on("y", plain);
const rawX = e.rawListeners("x");
const rawY = e.rawListeners("y");
console.log("raw-name", JSON.stringify(rawX[0].name));
console.log("listener-prop", rawX[0].listener === orig, typeof rawX[0].listener);
console.log("plain-identity", rawY[0] === plain);
console.log("listeners-identity", e.listeners("x")[0] === orig);
console.log("count-before", e.listenerCount("x"));
const answer = rawX[0]("direct");
console.log("direct-return", answer === undefined);
console.log("count-after", e.listenerCount("x"));

let ran = 0;
e.once("z", () => {
  ran += 1;
});
const rawZ = e.rawListeners("z");
rawZ[0]();
rawZ[0]();
console.log("double-call", ran);

// getEventListeners is Node's listeners() array for an EventEmitter, not the
// raw list: it answers the original, as listeners() does.
const e2 = new EventEmitter();
const fn = () => {};
e2.once("w", fn);
const gelW = getEventListeners(e2, "w");
console.log("gel-listeners", gelW[0] === fn, gelW[0].name);
