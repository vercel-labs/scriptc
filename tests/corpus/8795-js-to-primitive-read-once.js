// ToPrimitive reads an object's Symbol.toPrimitive member exactly once, with
// the operator's own hint, and only falls back to OrdinaryToPrimitive when
// the member is absent or holds undefined/null. A numeric conversion that
// read the member a second time would run the getter twice and could call a
// different hook with the wrong hint.
const primitiveKey = Symbol.toPrimitive;

// A getter that answers undefined leaves the ordinary conversion in charge,
// and runs once.
let log = "";
const undefinedHook = {
  get [primitiveKey]() {
    log += "get ";
    return undefined;
  },
  valueOf() {
    log += "valueOf";
    return 42;
  },
};
console.log("number", Number(undefinedHook), log);

// A member that starts answering on the second read must never get that
// read: the conversion that already asked may not ask again.
let stateful = "";
let reads = 0;
const statefulHook = {
  get [primitiveKey]() {
    reads += 1;
    stateful += "get ";
    if (reads > 1) return function (hint) { stateful += "call:" + hint + " "; return 99; };
    return null;
  },
  valueOf() {
    stateful += "valueOf";
    return 7;
  },
};
console.log("stateful", Number(statefulHook), stateful);

// The hook runs with the number hint, once, and its answer is the conversion.
let hinted = "";
const hintedHook = {
  [primitiveKey](hint) {
    hinted += "call:" + hint;
    return hint === "number" ? 11 : "not a number";
  },
};
console.log("hint", Number(hintedHook), hinted);

// The same rule on the operator paths that convert an operand with the
// number hint (BigInt and comparison operators) and the default hint.
let bigintLog = "";
const bigintHook = {
  get [primitiveKey]() {
    bigintLog += "get ";
    return undefined;
  },
  valueOf() {
    bigintLog += "valueOf";
    return 4;
  },
};
try { console.log("mixed", 3n % bigintHook, bigintLog); } catch (e) { console.log(e.name, e.message, bigintLog); }
let defaultLog = "";
const defaultHook = {
  get [primitiveKey]() {
    defaultLog += "get ";
    return undefined;
  },
  valueOf() {
    defaultLog += "valueOf";
    return 5n;
  },
};
console.log("default", defaultHook + 1n, defaultLog);
