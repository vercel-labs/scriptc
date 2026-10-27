// Iterable unions without an array arm, and optional or nullable Iterable
// slots that take a generator whose return channel is not void.

function* evens(limit: number): Generator<number, void, undefined> {
  for (let i = 0; i <= limit; i += 2) yield i;
}

// A union of a Set and a generator is an iterable union with no array arm:
// for-of walks every arm through the generator loop.
function total(src: Set<number> | Generator<number, void, undefined>): number {
  let sum = 0;
  for (const v of src) sum += v;
  return sum;
}
console.log(total(new Set([1, 2, 3])), total(evens(6)));

const labelled = (src: Set<number> | Generator<number, void, undefined>): string[] => {
  const out: string[] = [];
  outer: for (const v of src) {
    if (v > 4) break outer;
    out.push(`#${v}`);
  }
  return out;
};
console.log(labelled(new Set([1, 3, 5])).join(" "), labelled(evens(10)).join(" "));

// A generator that returns a value: its return channel is dropped when it
// flows into an Iterable, required, optional or nullable alike.
function* countdown(from: number): Generator<number, string, unknown> {
  for (let i = from; i > 0; i--) yield i;
  return "liftoff";
}

function joined(xs: Iterable<number>): string {
  return [...xs].join(",");
}

function maybeJoined(xs?: Iterable<number>): string {
  return xs === undefined ? "none" : [...xs].join(",");
}

function nullableJoined(xs: Iterable<number> | null): string {
  if (xs === null) return "null";
  let out = "";
  for (const x of xs) out += `${x};`;
  return out;
}

console.log(joined(countdown(3)));
console.log(maybeJoined(countdown(2)), maybeJoined(), maybeJoined(undefined), maybeJoined([7, 8]));
console.log(nullableJoined(countdown(4)), nullableJoined(null), nullableJoined(new Set([9])));
