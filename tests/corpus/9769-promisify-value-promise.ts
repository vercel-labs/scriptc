// `util.promisify(fn)`: when the callback's value is a promise, the promisified call adopts it
// (two turns later than a plain value), and a rejected one rejects the call.
import { promisify } from "node:util";

let tick = 0;
function spin(i: number): void {
  if (i < 8) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}
function later(n: number, done: (error: Error | null, value?: unknown) => void): void {
  if (n === 3) done(new Error("failed"));
  else if (n === 1) done(null, Promise.resolve("adopted"));
  else if (n === 2) done(null, Promise.reject(new Error("rejected inside")));
  else done(null, "plain");
}
const run = promisify(later);
spin(0);
for (const n of [0, 1, 2, 3]) {
  run(n).then(
    (v) => {
      console.log(n, "fulfilled", String(v), "tick", tick);
    },
    (e) => {
      console.log(n, "rejected", e instanceof Error ? e.message : String(e), "tick", tick);
    },
  );
}
