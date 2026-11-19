// A promise-like program value crosses the wrapper's dynamic call as a
// typed reference: its finally is read from the value's materialized view,
// the entry waits for that finally, and the call answers what finally
// returns.
import { performance, PerformanceObserver } from "node:perf_hooks";

const seen: string[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) seen.push(`${entry.name}:${entry.entryType}`);
});
observer.observe({ entryTypes: ["function"] });

interface LiteralThenable {
  finally(callback: () => void): LiteralThenable;
}

let finallyCalls = 0;
function makeLiteral(): LiteralThenable {
  const literal: LiteralThenable = {
    finally(callback) {
      finallyCalls += 1;
      callback();
      return literal;
    },
  };
  return literal;
}

const wrappedLiteral = performance.timerify(makeLiteral);
const result = wrappedLiteral();
console.log("literal", finallyCalls, result === result);

await new Promise((resolve) => setTimeout(resolve, 20));
observer.disconnect();
console.log("seen", seen.join(","));
