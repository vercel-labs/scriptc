// @requires-libnode
// An island value whose DECLARED type is an array of copied values crosses
// as a copy of its elements wherever native code needs a native value: the
// declaration decides the crossing, not the use. The copy carries the
// elements the checked conversion then meets, so a native function receives
// a real native array, `string[] | undefined` keeps its nullish arm, and
// nested arrays copy too.
import { empty, list, maybeList, nested } from "array-pkg";

/** Native code: it needs a real native array, not an island handle. */
function describe(values: string[]): string {
  let total = 0;
  for (const value of values) total += value.length;
  return values.length === 0 ? "(none)" : `${values.join("+")} ${total}`;
}

function count(values: readonly string[]): number {
  return values.length;
}

const names = list();
console.log(describe(names), count(names), names.length);

const missing = maybeList(false);
console.log(missing === undefined ? "missing" : describe(missing));
const present = maybeList(true);
console.log(present === undefined ? "missing" : describe(present));

const fallback = maybeList(false) ?? [];
console.log(describe(fallback), fallback.length);

console.log(describe(empty()), describe(nested()[0]!), count(nested()[1]!));

// The crossing copies: a native array the program sorts is its own, and a
// fresh read of the island's array is unaffected.
const first = list();
const second = list();
const sortedNative: string[] = [...first];
sortedNative.sort();
console.log(sortedNative.join(","), second.join(","), describe(first));

// A function-local island array captured by an arrow crosses the same way.
function captured(): string {
  const local = list();
  const show = (): string => describe(local);
  const size = (): number => local.length;
  const spread = (): string => [...local].join(",");
  return `${show()} ${size()} ${spread()}`;
}
console.log(captured());

// Closures declared before the island array they capture.
function capturedEarly(): string {
  const show = (): string => describe(early);
  const spread = (): string => [...early].join(",");
  function size(): number {
    return early.length;
  }
  const early = list();
  return `${show()} ${spread()} ${size()}`;
}
console.log(capturedEarly());
