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

mapGetterSeesInstance();
mapAccessorAdder();
mapGetterThrows();
nullishSkipsGetter();
setGetterSeesInstance();
setAccessorAdder();
setNullishSkipsGetter();
