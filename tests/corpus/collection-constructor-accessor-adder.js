// Map(iterable) and Set(iterable) read the adder off the new collection
// (Map step 8, Set step 7), so a getter installed on the prototype runs with
// that collection as `this`, once per construction, before the seed walks.
// The builtin it returns keeps the same collection: the constructor fills
// the instance the getter saw.

const builtinSet = Map.prototype.set;
const builtinAdd = Set.prototype.add;

function restoreMapSet() {
  Object.defineProperty(Map.prototype, "set", {
    value: builtinSet,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function restoreSetAdd() {
  Object.defineProperty(Set.prototype, "add", {
    value: builtinAdd,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function mapGetterSeesInstance() {
  let receiver;
  let sizeAtRead;
  let reads = 0;
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      reads += 1;
      receiver = this;
      sizeAtRead = this.size;
      return builtinSet;
    },
  });
  const map = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  restoreMapSet();
  // A collection whose destination has a native layout is filled from the
  // entries the adder inserted, so it need not be the receiver; the receiver
  // itself has to be the new, still empty Map.
  console.log(
    "map getter: reads",
    reads,
    "is a Map:",
    receiver instanceof Map,
    "size at read:",
    sizeAtRead,
    "size:",
    map.size,
    "get a:",
    map.get("a"),
  );
}

function mapAccessorAdder() {
  const seen = [];
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      return function (key, value) {
        seen.push(key + "=" + value + "@" + this.size);
        builtinSet.call(this, key, value);
      };
    },
  });
  const map = new Map([
    ["x", 1],
    ["y", 2],
  ]);
  restoreMapSet();
  console.log("map accessor adder:", seen.join(","), "size:", map.size);
}

function mapGetterThrows() {
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      throw new Error("getter failed");
    },
  });
  let stepped = 0;
  const iterable = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() {
        stepped += 1;
        return { value: ["a", 1], done: false };
      },
      return() {
        stepped += 100;
        return {};
      },
    };
  };
  try {
    new Map(iterable);
  } catch (error) {
    console.log("map getter throws:", error.message, "stepped:", stepped);
  } finally {
    restoreMapSet();
  }
}

function nullishSkipsGetter() {
  let reads = 0;
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      reads += 1;
      return builtinSet;
    },
  });
  const fromNull = new Map(null);
  const empty = new Map();
  const fromUndefined = new Map(undefined);
  restoreMapSet();
  console.log(
    "nullish seeds read the getter:",
    reads,
    "sizes:",
    fromNull.size,
    empty.size,
    fromUndefined.size,
  );
}

function setGetterSeesInstance() {
  let receiver;
  let sizeAtRead;
  let reads = 0;
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      reads += 1;
      receiver = this;
      sizeAtRead = this.size;
      return builtinAdd;
    },
  });
  const set = new Set([1, 2, 2]);
  restoreSetAdd();
  // A Set with a native element layout is filled from the values the adder
  // inserted, so the program's Set and the getter's receiver are different
  // objects; the receiver itself is what has to look like the new Set.
  console.log(
    "set getter: reads",
    reads,
    "is a Set:",
    receiver instanceof Set,
    "size at read:",
    sizeAtRead,
    "size:",
    set.size,
    "has 2:",
    set.has(2),
  );
}

function setAccessorAdder() {
  const seen = [];
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      return function (value) {
        seen.push(value + "@" + this.size);
        builtinAdd.call(this, value);
      };
    },
  });
  const set = new Set([1, 2]);
  restoreSetAdd();
  console.log("set accessor adder:", seen.join(","), "size:", set.size);
}

function setNullishSkipsGetter() {
  let reads = 0;
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      reads += 1;
      return builtinAdd;
    },
  });
  const fromNull = new Set(null);
  const empty = new Set();
  restoreSetAdd();
  console.log("set nullish seeds read the getter:", reads, "sizes:", fromNull.size, empty.size);
}

function mapStepsSeeInsertedEntries() {
  let captured;
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      captured = this;
      return builtinSet;
    },
  });
  const sizes = [];
  const iterable = {
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() {
          // The getter handed the iterator this collection, so each step
          // sees the entries the constructor added so far.
          sizes.push(captured.size);
          if (i === 2) return { value: undefined, done: true };
          i += 1;
          return { value: ["k" + i, i], done: false };
        },
      };
    },
  };
  const map = new Map(iterable);
  restoreMapSet();
  console.log("map steps see sizes:", sizes.join(","), "size:", map.size, "get k2:", map.get("k2"));
}

function setStepsSeeInsertedValues() {
  let captured;
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      captured = this;
      return builtinAdd;
    },
  });
  const sizes = [];
  const iterable = {
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() {
          sizes.push(captured.size);
          if (i === 3) return { value: undefined, done: true };
          i += 1;
          return { value: i, done: false };
        },
      };
    },
  };
  const set = new Set(iterable);
  restoreSetAdd();
  console.log("set steps see sizes:", sizes.join(","), "size:", set.size, "has 3:", set.has(3));
}

// A hole reaches an inherited indexed getter through the prototype chain. The
// getter sits on a plain object between the seed and Array.prototype, because
// an indexed accessor cannot be defined on an array.
function sparseSeed(elements, getter) {
  const seed = JSON.parse(elements);
  delete seed[1];
  const proto = Object.create(Array.prototype);
  Object.defineProperty(proto, "1", { configurable: true, get: getter });
  Object.setPrototypeOf(seed, proto);
  return seed;
}

function mapIteratorSeedSeesInsertedEntries() {
  let captured;
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      captured = this;
      return builtinSet;
    },
  });
  const sizes = [];
  // An array iterator reads a hole through the prototype chain, so this
  // inherited getter runs between the steps that insert the entries on
  // either side of it.
  const seed = sparseSeed('[["a",1],["b",2],["c",3]]', () => {
    sizes.push(captured.size);
    return ["b", 2];
  });
  const map = new Map(seed.values());
  restoreMapSet();
  console.log(
    "map iterator seed sees sizes:",
    sizes.join(","),
    "size:",
    map.size,
    "get b:",
    map.get("b"),
  );
}

function setIteratorSeedSeesInsertedValues() {
  let captured;
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      captured = this;
      return builtinAdd;
    },
  });
  const sizes = [];
  const seed = sparseSeed("[1,2,3]", () => {
    sizes.push(captured.size);
    return 2;
  });
  const set = new Set(seed.values());
  restoreSetAdd();
  console.log(
    "set iterator seed sees sizes:",
    sizes.join(","),
    "size:",
    set.size,
    "has 2:",
    set.has(2),
  );
}

function setKeysSeedSkipsGetter() {
  let captured;
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      captured = this;
      return builtinAdd;
    },
  });
  let calls = 0;
  // A keys() iterator forms the index numbers without reading an element, so
  // the hole is never a property read and the prototype getter stays out.
  const seed = sparseSeed("[1,2,3]", () => {
    calls += 1;
    return 99;
  });
  const set = new Set(seed.keys());
  restoreSetAdd();
  console.log(
    "set keys seed getter calls:",
    calls,
    "size:",
    set.size,
    "has 0:",
    set.has(0),
    "has 2:",
    set.has(2),
  );
}

function mapDirectSeedSeesInsertedEntries() {
  let captured;
  Object.defineProperty(Map.prototype, "set", {
    configurable: true,
    get() {
      captured = this;
      return builtinSet;
    },
  });
  const sizes = [];
  // The seed is the array itself, not an iterator over it. The constructor
  // inserts one entry per step, so the hole's inherited getter sees the entry
  // inserted before it.
  const seed = sparseSeed('[["a",1],["b",2],["c",3]]', () => {
    sizes.push(captured.size);
    return ["b", 2];
  });
  const map = new Map(seed);
  restoreMapSet();
  console.log(
    "map direct seed sees sizes:",
    sizes.join(","),
    "size:",
    map.size,
    "get b:",
    map.get("b"),
  );
}

function setDirectSeedSeesInsertedValues() {
  let captured;
  Object.defineProperty(Set.prototype, "add", {
    configurable: true,
    get() {
      captured = this;
      return builtinAdd;
    },
  });
  const sizes = [];
  const seed = sparseSeed("[1,2,3]", () => {
    sizes.push(captured.size);
    return 2;
  });
  const set = new Set(seed);
  restoreSetAdd();
  console.log(
    "set direct seed sees sizes:",
    sizes.join(","),
    "size:",
    set.size,
    "has 2:",
    set.has(2),
  );
}

mapGetterSeesInstance();
mapAccessorAdder();
mapGetterThrows();
nullishSkipsGetter();
setGetterSeesInstance();
setAccessorAdder();
setNullishSkipsGetter();
mapStepsSeeInsertedEntries();
setStepsSeeInsertedValues();
mapIteratorSeedSeesInsertedEntries();
setIteratorSeedSeesInsertedValues();
setKeysSeedSkipsGetter();
mapDirectSeedSeesInsertedEntries();
setDirectSeedSeesInsertedValues();
