// Module constants read as their literal values; bindings that change or
// can be read before their declaration keep their global.
import * as ns from "./consts.ts";
import { DOT, ENABLED, HALF, MINUS_ZERO, NEGATIVE, SLASH, bump, counter } from "./consts.ts";

const COLON = 0x3a;
const LIMIT = 3;

function classify(code: number): string {
  switch (code) {
    case SLASH:
      return "slash";
    case DOT:
      return "dot";
    case COLON:
      return "colon";
    case NEGATIVE:
      return "negative";
    default:
      return "other";
  }
}

const path = "a/b.c:d";
const kinds: string[] = [];
for (let i = 0; i < path.length; i++) kinds.push(classify(path.charCodeAt(i)));
console.log(kinds.join(","), classify(-1), classify(NaN));
console.log(HALF * 3, ENABLED && LIMIT > 2, Object.is(MINUS_ZERO, -0), 1 / MINUS_ZERO);
console.log(ns.DOT, ns.SLASH, Object.keys(ns).sort().join(" "));

// A mutable export keeps observing writes.
bump();
bump();
console.log(counter, ns.counter);

// A function hoisted above the declaration it reads still throws in the TDZ.
try {
  console.log(early());
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
const LATE = 7;
function early(): number {
  return LATE * 2;
}
console.log(early());

// A loop binding at module scope is written once per iteration.
const totals: number[] = [];
for (const step of [1, 2, 3]) totals.push(step * LIMIT);
console.log(totals.join(" "));
