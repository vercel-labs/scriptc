// The ES2025 Set compositions over a set-like argument: the protocol reads
// size, has and keys off the argument, and the result is always an ordinary
// Set (never a subclass, species never consulted).
function setLike(values, size) {
  return {
    size: size === undefined ? values.length : size,
    has(value) {
      return values.indexOf(value) >= 0;
    },
    keys() {
      let i = 0;
      return {
        next() {
          return i < values.length ? { value: values[i++], done: false } : { done: true };
        },
      };
    },
  };
}
const log = (label, value) => console.log(label, JSON.stringify(value));
const base = new Set([1, 2, 3]);
log("union", [...base.union(setLike([3, 4, 1]))]);
log("intersection", [...base.intersection(setLike([2, 3, 4]))]);
log("difference", [...base.difference(setLike([2, 9]))]);
log("symmetricDifference", [...base.symmetricDifference(setLike([2, 9]))]);
log("isSubsetOf", new Set([1, 2]).isSubsetOf(setLike([3, 2, 1])));
log("isSupersetOf", base.isSupersetOf(setLike([3, 1])));
log("isSubsetOf bigger", base.isSubsetOf(setLike([1])));
log("isSupersetOf smaller", base.isSupersetOf(setLike([1, 2, 3, 4])));
log("isDisjointFrom", base.isDisjointFrom(setLike([3, 4])));

// A Map is a set-like whose keys are its entries.
log("union map", [...new Set([1]).union(new Map([[2, "b"], [1, "a"]]))]);
log("intersection map", [...new Set([1, 2]).intersection(new Map([[2, "b"], [3, "c"]]))]);
log("difference map", [...new Set([1, 2]).difference(new Map([[2, "b"]]))]);

// Observable order: the receiver's elements first, then the argument's keys.
const calls = [];
const other = {
  size: 1,
  has(value) {
    calls.push("has " + value);
    return false;
  },
  keys() {
    calls.push("keys");
    let i = 0;
    return {
      next() {
        return i++ < 1 ? { value: 7, done: false, i } : { done: true };
      },
    };
  },
};
log("order union", [...new Set([1, 2]).union(other)]);
log("order calls", calls);

// The size branch: an argument claiming fewer elements drives
// intersection/difference/isDisjointFrom/isSubsetOf through its keys.
const small = {
  size: 1,
  has(value) {
    calls.push("small has " + value + " " + this.size);
    return value === 2;
  },
  keys() {
    calls.push("small keys");
    return setLike([2, 8]).keys();
  },
};
log("size branch intersection", [...new Set([1, 2, 3]).intersection(small)]);
log("size branch difference", [...new Set([1, 2, 3]).difference(small)]);
log("size branch disjoint", base.isDisjointFrom(small));
log("size branch calls", calls);

// The keys iterator is closed when the algorithm returns early.
let closed = 0;
const closable = {
  size: 1,
  has() {
    return false;
  },
  keys() {
    let i = 0;
    return {
      next() {
        return i++ < 5 ? { value: 100 + i, done: false } : { done: true };
      },
      return() {
        closed++;
        return {};
      },
    };
  },
};
log("close superset", base.isSupersetOf(closable));
log("closed count", closed);
base.isDisjointFrom(closable);
log("closed after disjoint", closed);

// -0 is canonicalized in the result.
const zero = new Set([-0]).union(setLike([0])).values().next().value;
log("negative zero", [String(zero), Object.is(zero, 0), Object.is(zero, -0)]);
log("negative zero difference", [...new Set([0]).difference(setLike([-0]))].length);

// The result is always an ordinary Set with Set.prototype as its prototype,
// whichever receiver or argument produced it.
const composed = new Set([1]).union(new Map([[2, "b"]]));
log("result proto", Object.getPrototypeOf(composed) === Set.prototype);
log("result tag", Object.prototype.toString.call(composed));

// A native Set iterator serves as the set-like's keys; the composition drives
// it through the iterator protocol like any other iterator.
log("handle keys", [...base.union({ size: 2, has: () => false, keys: () => new Set([8, 9]).values() })]);

// GetSetRecord errors: only the error names are stable across engines.
const refusal = (label, run) => {
  try {
    run();
    console.log(label, "no error");
  } catch (error) {
    console.log(label, error.name, error instanceof TypeError);
  }
};
refusal("union number", () => base.union(1));
refusal("union null", () => base.union(null));
refusal("union undefined", () => base.union(undefined));
refusal("union NaN size", () => base.union({ size: NaN, has() {}, keys() {} }));
refusal("union negative size", () => base.union({ size: -2, has() {}, keys() {} }));
refusal("union bigint size", () => base.union({ size: 0n, has() {}, keys() {} }));
refusal("union has not callable", () => base.union({ size: 1, has: {}, keys() {} }));
refusal("union keys not callable", () => base.union({ size: 1, has() {}, keys: 0 }));
refusal("union keys result", () => base.union({ size: 1, has() {}, keys: () => 5 }));
refusal("union throwing has", () => base.union({ size: 1, has() { throw new RangeError("stop"); }, keys() {} }));

// IteratorClose runs the argument's `return` after an early exit: a throw
// from it, a `return` that is not callable, and a `return` that answers a
// non-object all surface even though the algorithm already decided.
refusal("close throws", () =>
  base.isSupersetOf({
    size: 1,
    has: () => false,
    keys: () => ({
      next: () => ({ done: false, value: 42 }),
      return() {
        throw new RangeError("closed");
      },
    }),
  }),
);
refusal("close not callable", () =>
  base.isSupersetOf({
    size: 1,
    has: () => false,
    keys: () => ({ next: () => ({ done: false, value: 42 }), return: 5 }),
  }),
);
refusal("close non-object", () =>
  base.isSupersetOf({
    size: 1,
    has: () => false,
    keys: () => ({ next: () => ({ done: false, value: 42 }), return: () => 5 }),
  }),
);
