// util.format and console.log %d / %i over arguments Node formats without a
// number conversion: a bigint prints with its n suffix, a symbol as NaN,
// null as 0 under %d and NaN under %i, and undefined as NaN. Arguments still
// evaluate in order.
import { format } from "node:util";

const calls: string[] = [];
function big(n: bigint): bigint {
  calls.push(`big ${n}`);
  return n;
}
function sym(): symbol {
  calls.push("sym");
  return Symbol("s");
}
function nothing(): undefined {
  calls.push("nothing");
  return undefined;
}

console.log(format("%d %i", 10n, -5n));
console.log(format("%d", 2n ** 70n), format("%i", -(2n ** 65n)));
console.log(format("%d|%i", 0n, 0n));
console.log(format("%d %i", Symbol("x"), Symbol.iterator));
console.log(format("%d %i", null, null));
console.log(format("%d %i", undefined, undefined));
console.log(format("%d-%i-%d", big(3n), sym(), nothing()), calls.join(", "));
console.log("count %d of %i", 42n, 7n);
console.log("missing %d", null, "extra");
