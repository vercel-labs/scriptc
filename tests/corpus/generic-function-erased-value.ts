// A generic function stored where no signature pins its type arguments (an
// `unknown` or `any` slot) is the function JavaScript runs for any of them.
function identity<T>(value: T): T {
  return value;
}

function pair<A, B>(first: A, second: B): [A, B] {
  return [first, second];
}

function call(fn: any, first: unknown, second?: unknown): unknown {
  return fn(first, second);
}

const table: Record<string, unknown> = { identity, pair };
console.log(call(identity, 4));
console.log(call(identity, "text"));
console.log(JSON.stringify(call(pair, 1, "b")));
console.log(typeof table.identity, typeof table.pair);
console.log(JSON.stringify(call(table.pair, [true], null)));
