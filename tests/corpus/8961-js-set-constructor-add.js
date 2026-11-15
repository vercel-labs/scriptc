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

/** An iterable whose iterator logs `return`, for the step failures. */
function watchedIterable(step) {
  const log = [];
  const iterable = {};
  iterable[Symbol.iterator] = function () {
    let index = 0;
    return {
      next() {
        index += 1;
        return step(index);
      },
      return() {
        log.push("return");
        return {};
      },
    };
  };
  return { iterable, log };
}

function stepFailuresDoNotClose() {
  // A throw from `next`, from the `done` or `value` accessor, or a primitive
  // result ends AddEntriesFromIterable on its own: only the adder's throw
  // performs IteratorClose.
  Set.prototype.add = function (value) {
    builtinAdd.call(this, value);
  };
  const nextFailure = watchedIterable((index) => {
    if (index === 2) throw new Error("next failed");
    return { value: index, done: false };
  });
  try {
    new Set(nextFailure.iterable);
  } catch (error) {
    console.log("next throws:", error.message, "returned:", nextFailure.log.length);
  }
  const valueFailure = watchedIterable((index) => {
    if (index === 2) {
      return {
        get value() {
          throw new Error("value failed");
        },
        done: false,
      };
    }
    return { value: index, done: false };
  });
  try {
    new Set(valueFailure.iterable);
  } catch (error) {
    console.log("value throws:", error.message, "returned:", valueFailure.log.length);
  }
  const doneFailure = watchedIterable((index) => {
    if (index === 2) {
      return {
        get done() {
          throw new Error("done failed");
        },
      };
    }
    return { value: index, done: false };
  });
  try {
    new Set(doneFailure.iterable);
  } catch (error) {
    console.log("done throws:", error.message, "returned:", doneFailure.log.length);
  }
  const primitive = watchedIterable((index) => (index === 2 ? 7 : { value: index, done: false }));
  try {
    new Set(primitive.iterable);
  } catch (error) {
    console.log("primitive result:", error.message, "returned:", primitive.log.length);
  }
  restore();
}

function mutatedArraySeed() {
  // The constructor walks the seed as it stands at each step, so an `add`
  // that appends to the seed is called for the appended values too.
  const seed = [1, 2, 3];
  const seen = [];
  Set.prototype.add = function (value) {
    seen.push(value);
    if (value === 1) seed.push(4);
    builtinAdd.call(this, value);
  };
  const set = new Set(seed);
  restore();
  console.log("grown array seed:", [...set], "visited:", seen);
}

function shrunkArraySeed() {
  // A removal before the next step leaves the iteration reading the seed's
  // live indices, as Node's array iterator does.
  const seed = [1, 2, 3, 4];
  const seen = [];
  Set.prototype.add = function (value) {
    seen.push(value);
    if (value === 1) seed.shift();
    builtinAdd.call(this, value);
  };
  const set = new Set(seed);
  restore();
  console.log("shrunk array seed:", [...set], "visited:", seen);
}

function mutatedBytesSeed() {
  // A typed array seed keeps its view: a write through the seed is read by
  // the step that follows it.
  const seed = new Uint8Array([1, 2, 3]);
  const seen = [];
  Set.prototype.add = function (value) {
    seen.push(value);
    if (value === 1) seed[2] = 9;
    builtinAdd.call(this, value);
  };
  const set = new Set(seed);
  restore();
  console.log("bytes seed:", [...set], "visited:", seen);
}

console.log("empty:", new Set().size);
readsAdd();
notCallable();
nullishSeed();
closesIterator();
stepsSeed();
stepFailuresDoNotClose();
mutatedArraySeed();
shrunkArraySeed();
mutatedBytesSeed();

