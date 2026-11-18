// performance.timerify without an observer or histogram: the wrapper alone
// is enough, and a program that only wraps a function still needs the perf
// unit (and its entry machinery) linked.
import { timerify } from "node:perf_hooks";

const doubled = timerify(function doubler(n) {
  return n * 2;
});
console.log("plain", doubled(3), doubled.name, doubled.length);

const gathered = timerify(async function gather(n) {
  return n + 1;
});
console.log("async", await gathered(41));
