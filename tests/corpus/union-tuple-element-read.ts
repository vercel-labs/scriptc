// Literal-index reads from a union of tuples whose element types differ:
// each tuple's own element is read, and the checker's narrowing of the
// tuple (or of the element) applies as usual.

type Ok<T> = readonly [true, T];
type Err<E> = readonly [false, E];
type Result<T, E> = Ok<T> | Err<E>;

function pick(n: number): Result<number, string> {
  return n > 0 ? [true, n] : [false, "neg"];
}

for (const n of [1, -1, 5]) {
  const r = pick(n);
  console.log(r[0], r[1]);
  if (r[0]) console.log(r[1] + 1);
  else console.log(r[1].length);
}

function describe(r: Result<number, string>): string {
  const value = r[1];
  return `${r[0] ? "ok" : "err"}:${typeof value}:${value}`;
}
console.log(describe(pick(2)), describe(pick(0)));

function isOk<T, E>(r: Result<T, E>): boolean {
  return r[0];
}
function payload<T, E>(r: Result<T, E>): T | E {
  return r[1];
}
console.log(isOk(pick(3)), isOk(pick(-3)), payload(pick(4)), payload(pick(-4)));

type Triple = readonly [string, number, boolean] | readonly [number, string, boolean];
const triples: Triple[] = [
  ["a", 1, true],
  [2, "b", false],
];
for (const t of triples) console.log(typeof t[0], typeof t[1], t[2]);

// A read through a single tuple view of the union.
function flag<T, E>(r: Result<T, E>): boolean {
  return (r as readonly [boolean, T | E])[0];
}
console.log(flag(pick(1)), flag(pick(-1)));
