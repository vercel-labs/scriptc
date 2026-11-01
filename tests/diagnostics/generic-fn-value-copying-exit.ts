// A generic function value whose boundary conversion would COPY the value
// is refused, never silently compiled: JavaScript hands the same object
// across, so an erased instance that answers a copy would diverge.
// (A promise payload boxes by reference — object-model S1 — so it crosses
// freely; tests/corpus/8976-erased-promise-payload-identity.ts pins that.)

interface Row {
  id: number;
  tag: string;
}
const shared: Row = { id: 1, tag: "a" };

// A record argument converting to a NARROWER record copies, so a
// generic method's value refuses the same way. (A direct call of `bump`
// keeps the width copy and its SC6001 warning; the erased boundary has no
// such exit, so it refuses instead of answering a copy.)
const util = {
  bump<U>(x: U, opts: { id: number }): number {
    opts.id = 99;
    return opts.id;
  },
};
const erased = util.bump;
const wide = { id: 2, tag: "b", extra: true };
console.log(erased(1, wide), wide.id);

// A callback the erased call boxes runs through the dynamic tier, whose
// SYNCHRONOUS answer to a record or array result is a fresh value: the
// object the callback returned does not come back, so the call is refused.
// (The record itself still arrives live, so a mutation of its fields is
// seen.)
class Store {
  map<T>(value: T, apply: (input: T) => T): T {
    return apply(value);
  }
}
const store = new Store();
const map = store.map;
console.log(map(shared, (input) => input));

// A record field holds the same erased instance, and a call through the
// field crosses the same boundary: the refusal is not bypassed by the
// storage.
const holder = { map: store.map };
console.log(holder.map(shared, (input) => input));
