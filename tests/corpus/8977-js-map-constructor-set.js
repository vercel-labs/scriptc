// Map(iterable) reads `set` off the new map (Map ( [ iterable ] ), step 8),
// so a program's own Map.prototype.set runs once per entry with (value, key)
// and `this` bound to the map, and a throwing one closes the iterator.

const builtinSet = Map.prototype.set;

function restore() {
  Map.prototype.set = builtinSet;
}

function readsSet() {
  const seen = [];
  Map.prototype.set = function (key, value) {
    seen.push(key + "=" + value + "@" + this.size);
    builtinSet.call(this, key, value);
  };
  const entries = [
    ["a", 1],
    ["b", 2],
  ];
  const map = new Map(entries);
  restore();
  console.log("set calls:", seen.join(","), "size:", map.size, "get a:", map.get("a"));
}

function notCallable() {
  for (const value of [null, 0, undefined]) {
    Map.prototype.set = value;
    try {
      new Map([["a", 1]]);
    } catch (error) {
      console.log("not callable:", error.constructor.name, error.message);
    } finally {
      restore();
    }
  }
}

function nullishSeed() {
  // A nullish iterable returns the empty map without reading `set`.
  Map.prototype.set = function () {
    throw new Error("set must not run");
  };
  const fromNull = new Map(null);
  const fromUndefined = new Map(undefined);
  restore();
  console.log("nullish seeds:", fromNull.size, fromUndefined.size);
}

function closesIterator() {
  let closed = 0;
  const iterable = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() {
        return { value: ["a", 1], done: false };
      },
      return() {
        closed += 1;
        return {};
      },
    };
  };
  Map.prototype.set = function () {
    throw new Error("set failed");
  };
  try {
    new Map(iterable);
  } catch (error) {
    console.log("closed when set throws:", error.message, closed);
  } finally {
    restore();
  }
}

function entryProtocol() {
  // The constructor validates each entry object and reads its 0 and 1
  // members before the adder call.
  const seen = [];
  Map.prototype.set = function (key, value) {
    seen.push(String(key) + ":" + String(value));
    builtinSet.call(this, key, value);
  };
  const fromArray = new Map([["only"]]);
  const objects = [
    { 0: "p", 1: 7 },
    { 0: "q" },
  ];
  const fromObjects = new Map(objects);
  restore();
  console.log(
    "entries:",
    seen.join(","),
    "short:",
    String(fromArray.get("only")),
    "object key:",
    fromObjects.get("p"),
    "object short:",
    String(fromObjects.get("q")),
  );
}

function notAnEntry() {
  for (const value of [1, "ab", null, undefined, true]) {
    try {
      new Map([value]);
    } catch (error) {
      console.log("not an entry:", error.constructor.name, error.message);
    }
  }
}

function adderSeesKeys() {
  // An adder that stores nothing leaves the map empty even though the
  // iteration ran to completion.
  let calls = 0;
  Map.prototype.set = function () {
    calls += 1;
  };
  const map = new Map([["a", 1], ["b", 2]]);
  restore();
  console.log("ignored adder:", calls, map.size);
}

console.log("empty:", new Map().size);
readsSet();
notCallable();
nullishSeed();
closesIterator();
entryProtocol();
notAnEntry();
adderSeesKeys();
