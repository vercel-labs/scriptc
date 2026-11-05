// tty.isatty stored as a value keeps the direct predicate's answers, its
// identity across import forms, and its name and length. Values that are
// not integral file descriptors answer false without being coerced.
import * as tty from "node:tty";
import { isatty } from "node:tty";
import ttyDefault from "node:tty";

const probe = tty.isatty;
console.log(typeof probe, probe.name, probe.length);
console.log(probe === isatty, probe === ttyDefault.isatty);
console.log(probe(-1), probe(1.5), probe(2 ** 31), probe(Number.NaN));
console.log([-1, 0.5].map(probe));
// Called through an untyped callback, values that are not numbers answer
// false without being coerced.
function forward(predicate, value) {
  return predicate(value);
}
let reads = 0;
const object = { valueOf() { reads++; return 1; } };
console.log(forward(probe, undefined), forward(probe, "1"), forward(probe, 1n), forward(probe, null), forward(probe, object), reads);
console.log(forward(isatty, -1), forward(tty.isatty, 2 ** 31));
