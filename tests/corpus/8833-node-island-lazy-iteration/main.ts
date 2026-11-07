// @requires-libnode
// `for…of` over an island iterable steps it lazily: the island's generator
// body runs only when the loop asks for the next value, so the island's own
// output interleaves with the loop's and a `break`, `throw` or `return` in
// the body closes the generator (its finally runs) instead of draining it.
import { boxed, counted, echo, naturals, pairs, throwsLater } from "iter-pkg";

for (const x of naturals(3)) {
  console.log("got", x);
  if (x >= 1) break;
}
console.log("end");

for (const x of counted(5)) {
  console.log("body", x);
  if (x === 1) break;
}

try {
  for (const x of throwsLater()) console.log("v", x);
} catch (e) {
  console.log("caught", (e as Error).message);
}

try {
  for (const x of counted(5)) {
    console.log("t", x);
    if (x === 0) throw new Error("body-boom");
  }
} catch (e) {
  console.log("caught", (e as Error).message);
}

function take(): number {
  for (const x of counted(9)) {
    if (x === 2) return x * 10;
  }
  return -1;
}
console.log("take", take());

const it = naturals(4);
console.log("next", it.next().value, it.next().value);
for (const x of it) console.log("rest", x);
console.log("stopped");

for (const [k, v] of pairs()) console.log(k, v);

const words: string[] = [];
for (const w of boxed.values()) {
  words.push(w);
  if (words.length === 1) break;
}
console.log(words.join(","), boxed.count);

// A typed input channel: the value of each next(value) reaches the island
// generator.
const echoed = echo();
console.log(echoed.next(0).value);
console.log(echoed.next(1).value);
console.log(echoed.next(2).value);
console.log(echoed.next(3).done);
