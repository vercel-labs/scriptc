// Generic functions used as VALUES with no concrete signature in sight.
// JavaScript erases type parameters, so the value is the ONE function every
// instantiation calls: the declaration lowered once with its type parameters
// bound to `unknown`. A call through it converts its arguments in and its
// result out, and a record that crosses the boundary comes back as the same
// object.

function identity<T>(x: T): T {
  return x;
}

// No pinning context: the value is the erased function. `typeof` reads it,
// and calling it still instantiates.
const stored = identity;
console.log(typeof stored, stored(5), stored("text"));

// An alias of an alias reaches the same erased function.
const again = stored;
console.log(typeof again, again([1, 2, 3]).length);

// A RESULT that is itself a generic function (the createLimiter shape): the
// returned closure keeps its own type parameter and erases the same way.
const curried = <T>(x: T) => <U>(y: U): string => `${x}|${y}`;
console.log(curried(1)("a"), curried("b")(2));

// A generic method read as a value: off an object literal, and off an
// instance (a bound-method reference).
const util = { id<T>(x: T): T { return x; } };
const unpinned = util.id;
console.log(typeof unpinned, unpinned(7), unpinned("seven"));
class Box {
  wrap<T>(x: T): T {
    return x;
  }
}
const bound = new Box().wrap;
console.log(typeof bound, bound("boxed"));

// Identity across the erased boundary: a record boxes as a live capsule of
// itself, so it comes back as the same object wherever it crossed.
interface Row {
  id: number;
  tag: string;
}
const shared: Row = { id: 1, tag: "a" };
console.log(identity(shared) === shared, stored(shared) === shared, unpinned(shared) === shared);
const rows: Row[] = [shared];
console.log(identity(rows) === rows, identity(rows)[0] === shared);

// A generic member's value stored on a record, called through the field.
const registry = { run: identity };
console.log(registry.run(3), registry.run("three"));

// The erased value and a monomorphized pin both compile and agree on values.
const pinned: (x: number) => number = identity;
console.log(pinned(9), stored(9));

// JavaScript has ONE function object per declaration, so the erased value a
// plain binding holds and a pinned instance of the same declaration compare
// equal. The assertions keep the comparison a value comparison (a typed
// comparison pins the unpinned side's signature, which this program holds at
// two, and refuses).
console.log((pinned as any) === (stored as any), (pinned as any) !== (stored as any));

// A generic value over PRIMITIVES that returns a promise: the payload is not
// a record, so nothing needs copying and the limiter composes.
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (run) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await run();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const limit = createLimiter(1);
async function main(): Promise<void> {
  const [n, s] = await Promise.all([limit(async () => 41 + 1), limit(async () => "text")]);
  console.log(n, s);
}
void main();
