// A generic function value whose boundary conversion would COPY the value
// is refused, never silently compiled: JavaScript hands the same object
// across, so an erased instance that answers a copy would diverge.

interface Row {
  id: number;
  tag: string;
}
const shared: Row = { id: 1, tag: "a" };

// A promise payload crossing into `unknown` is re-materialized when it
// settles, so a callback returning a promise of a record loses that
// record's identity (the createLimiter shape).
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  return async (run) => run();
}
const limit = createLimiter(1);
async function throughPromise(): Promise<void> {
  const r = await limit(async () => shared);
  console.log(r === shared);
}
void throughPromise();

// A record argument converting to a NARROWER record copies too, so a
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
