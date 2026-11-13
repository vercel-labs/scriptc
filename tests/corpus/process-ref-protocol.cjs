// process.ref / process.unref: Node reads the nodejs.ref / nodejs.unref
// symbol on the argument (running a getter there), falls back to the
// ref / unref member when that value is falsy, calls a callable result with
// the argument as receiver, and treats null, undefined and primitives as
// no-ops.
const refSymbol = Symbol.for("nodejs.ref");
const unrefSymbol = Symbol.for("nodejs.unref");
const log = [];

console.log("symbols", refSymbol === Symbol.for("nodejs.ref"), unrefSymbol === Symbol.for("nodejs.unref"));

const withSymbols = {
  [refSymbol]() {
    log.push("ref-symbol:" + (this === withSymbols));
  },
  [unrefSymbol]() {
    log.push("unref-symbol:" + (this === withSymbols));
  },
};
process.ref(withSymbols);
process.unref(withSymbols);

const withMembers = {
  ref() {
    log.push("ref-member:" + (this === withMembers));
  },
  unref() {
    log.push("unref-member:" + (this === withMembers));
  },
};
process.ref(withMembers);
process.unref(withMembers);

// A falsy symbol value falls back to the member; a truthy non-function does
// not: Node only calls the value when it is a function.
const fallback = {
  [refSymbol]: 0,
  ref() {
    log.push("ref-fallback:" + (this === fallback));
  },
};
process.ref(fallback);
const nonFunction = {
  [refSymbol]: "not callable",
  [unrefSymbol]: {},
};
process.ref(nonFunction);
process.unref(nonFunction);

// A getter for the symbol runs once, on the argument, and the function it
// returns runs with the argument as receiver.
const accessor = {};
Object.defineProperty(accessor, refSymbol, {
  get() {
    log.push("ref-getter");
    return function () {
      log.push("ref-getter-call:" + (this === accessor));
    };
  },
});
process.ref(accessor);

// Null, undefined and primitives answer without reading anything.
for (const value of [null, undefined, 5, "text", true, Symbol("probe"), 0n]) {
  process.ref(value);
  process.unref(value);
}

// A member that throws propagates the error unchanged.
const throwing = {
  ref() {
    throw new TypeError("ref refused");
  },
};
try {
  process.ref(throwing);
} catch (error) {
  log.push("ref-threw:" + error.name + ":" + error.message);
}

// The symbol is read before the member: a symbol value shadows a member.
const shadowed = {
  [refSymbol]() {
    log.push("symbol-wins");
  },
  ref() {
    log.push("member-lost");
  },
};
process.ref(shadowed);

console.log(log.join("\n"));
