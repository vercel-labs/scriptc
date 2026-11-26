// A generic function value whose boundary conversion would COPY the value
// is refused, never silently compiled: JavaScript hands the same object
// across, so an erased instance that answers a copy would diverge.
// (A record or array RESULT of a boxed callback crosses as a LIVE capsule,
// so the object the callback returned comes back — tests/corpus/
// setstate-updater-records.ts pins that. A promise payload boxes by
// reference — object-model S1 — so it crosses freely; tests/corpus/
// 8976-erased-promise-payload-identity.ts pins that.)

interface Row {
  id: number;
  tag: string;
}

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
