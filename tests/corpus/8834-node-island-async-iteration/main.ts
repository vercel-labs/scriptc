// @requires-libnode
// `for await` over an island async generator: each next() answers an island
// promise the loop awaits, so values arrive in order, a `break` or `return`
// closes the generator (its finally runs), a rejection surfaces as the loop's
// error, and a synchronous island iterable goes through the async-from-sync
// protocol (each value awaited).
import { naturals, rejects, ticked, ticks } from "iter-pkg";

let sum = 0;
for await (const t of ticks(3)) sum += t;
console.log("sum", sum);

for await (const t of ticked(5)) {
  console.log("a", t);
  if (t === 1) break;
}

try {
  for await (const t of rejects()) console.log("v", t);
} catch (e) {
  console.log("caught", (e as Error).message);
}

try {
  for await (const t of ticked(5)) {
    console.log("b", t);
    if (t === 0) throw new Error("body-boom");
  }
} catch (e) {
  console.log("caught", (e as Error).message);
}

async function take(): Promise<number> {
  for await (const t of ticks(9)) {
    if (t === 2) return t * 10;
  }
  return -1;
}
console.log("take", await take());

let s2 = 0;
for await (const v of naturals(4)) s2 += v;
console.log("sync", s2);
