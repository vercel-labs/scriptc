// Set(iterable) reads `add` off the new set (Set( [ iterable ] ), step 7),
// so a program's own Set.prototype.add runs once per value, and a throwing
// one closes the iterator (step 9).

const builtinAdd = Set.prototype.add;

function restore() {
  Set.prototype.add = builtinAdd;
}

function readsAdd() {
  const seen = [];
  Set.prototype.add = function (value) {
    seen.push(value);
    builtinAdd.call(this, value);
  };
  const set = new Set([1, 2, 2]);
  restore();
  console.log("add calls:", seen, "size:", set.size, "has 2:", set.has(2));
}

function notCallable() {
  for (const value of [null, 0, undefined]) {
    Set.prototype.add = value;
    try {
      new Set([1, 2]);
    } catch (error) {
      console.log("not callable:", error.constructor.name, error.message);
    } finally {
      restore();
    }
  }
}

function nullishSeed() {
  // A nullish iterable returns the empty set without reading `add`.
  Set.prototype.add = function () {
    throw new Error("add must not run");
  };
  const fromNull = new Set(null);
  const fromUndefined = new Set(undefined);
  restore();
  console.log("nullish seeds:", fromNull.size, fromUndefined.size);
}

function closesIterator() {
  let closed = 0;
  const iterable = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() {
        return { value: null, done: false };
      },
      return() {
        closed += 1;
        return {};
      },
    };
  };
  Set.prototype.add = function () {
    throw new Error("add failed");
  };
  try {
    new Set(iterable);
  } catch (error) {
    console.log("closed when add throws:", error.message, closed);
  } finally {
    restore();
  }
}

function stepsSeed() {
  // The adder stays a pass-through, so the element types still hold; it
  // counts the calls both constructions make through it.
  let calls = 0;
  Set.prototype.add = function (value) {
    calls += 1;
    builtinAdd.call(this, value);
  };
  /** @type {any} */
  const inner = new Set([1, 2]);
  const stepped = new Set(inner);
  const letters = new Set("aba");
  restore();
  console.log("stepped:", [...stepped], [...letters], "calls:", calls);
}

console.log("empty:", new Set().size);
readsAdd();
notCallable();
nullishSeed();
closesIterator();
stepsSeed();
