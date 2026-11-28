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

// A saved wrapper owns its call state: it keeps working after the
// registration is removed, and runs the original once.
let lost = 0;
const e3 = new EventEmitter();
const lostFn = () => {
  lost += 1;
};
e3.once("gone", lostFn);
const goneWrapper = e3.rawListeners("gone")[0];
e3.off("gone", lostFn);
goneWrapper();
goneWrapper();
console.log("after-off", lost, e3.listenerCount("gone"));

let wiped = 0;
const e4 = new EventEmitter();
const wipedFn = () => {
  wiped += 1;
};
e4.once("gone", wipedFn);
const wipedWrapper = e4.rawListeners("gone")[0];
e4.removeAllListeners("gone");
wipedWrapper();
wipedWrapper();
console.log("after-remove-all", wiped);

// The wrapper is also a removeListener/listenerCount identity: Node matches
// a once entry by `list.listener === listener` as well as by the wrapper.
let removed = 0;
const e5 = new EventEmitter();
const removedFn = () => {
  removed += 1;
};
e5.once("hit", removedFn);
const hitWrapper = e5.rawListeners("hit")[0];
console.log("wrapper-count", e5.listenerCount("hit", hitWrapper), e5.listenerCount("hit", removedFn));
e5.off("hit", hitWrapper);
console.log("wrapper-off", e5.listenerCount("hit"), e5.listenerCount("hit", hitWrapper));
hitWrapper();
console.log("wrapper-removed-call", removed);

// After an emit took the once, a saved wrapper is spent.
let consumed = 0;
const e6 = new EventEmitter();
const consumedFn = () => {
  consumed += 1;
};
e6.once("taken", consumedFn);
const takenWrapper = e6.rawListeners("taken")[0];
e6.emit("taken");
takenWrapper();
console.log("after-emit", consumed);

// rawListeners answers the SAME wrapper object each time it is asked.
const e7 = new EventEmitter();
e7.once("same", () => {});
const firstRead = e7.rawListeners("same")[0];
const secondRead = e7.rawListeners("same")[0];
console.log("wrapper-identity", firstRead === secondRead);

// An emit's snapshot holds the once entry. When an earlier listener removes
// that registration and calls the saved wrapper, the wrapper's own fired
// state makes the snapshot's later call a no-op (Node never runs it twice).
let snapshotRuns = 0;
const e8 = new EventEmitter();
const snapshotFn = () => {
  snapshotRuns += 1;
};
let snapshotWrapper;
e8.on("snap", () => {
  e8.off("snap", snapshotFn);
  snapshotWrapper();
});
e8.once("snap", snapshotFn);
snapshotWrapper = e8.rawListeners("snap")[1];
e8.emit("snap");
console.log("snapshot-off-original", snapshotRuns, e8.listenerCount("snap"));

let wipedRuns = 0;
const e9 = new EventEmitter();
const wipedOnce = () => {
  wipedRuns += 1;
};
let snapshotWipeWrapper;
e9.on("snap", () => {
  e9.removeAllListeners("snap");
  snapshotWipeWrapper();
});
e9.once("snap", wipedOnce);
snapshotWipeWrapper = e9.rawListeners("snap")[1];
e9.emit("snap");
console.log("snapshot-remove-all", wipedRuns, e9.listenerCount("snap"));

let wrapperRemovedRuns = 0;
const e10 = new EventEmitter();
const wrapperRemovedFn = () => {
  wrapperRemovedRuns += 1;
};
let snapshotRemoved;
e10.on("snap", () => {
  e10.removeListener("snap", snapshotRemoved);
  snapshotRemoved();
});
e10.once("snap", wrapperRemovedFn);
snapshotRemoved = e10.rawListeners("snap")[1];
e10.emit("snap");
console.log("snapshot-off-wrapper", wrapperRemovedRuns, e10.listenerCount("snap"));

// An abandoned emitter whose rawListeners wrapper was built is collectable:
// the sanitized lane's runtime RC audit fails on a cycle that survives.
(function () {
  const e = new EventEmitter();
  e.once("abandoned", () => {});
  e.rawListeners("abandoned");
})();
console.log("abandoned-ok");
