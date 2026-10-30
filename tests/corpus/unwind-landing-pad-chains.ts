// Exceptions thrown below functions that hold references and propagate by
// unwinding: landing pads release a frame's strings and arrays and continue
// the unwind, also where the frame is inlined into a caller whose own handler
// takes the exception, and through methods, closures and deep chains.
function leaf(n: number): number {
  if (n % 3 === 0) throw new RangeError("leaf " + n);
  return n * 2;
}
function first(n: number): number {
  return leaf(n) + 1;
}
function second(n: number): number {
  return first(n) * 3;
}
function third(n: number): number {
  return second(n) - 2;
}
function holder(n: number): number {
  const parts: string[] = ["a" + n];
  const r = third(n);
  parts.push("b");
  return r + parts.length;
}
function labelled(n: number): number {
  const label = "u" + n;
  return holder(n) + label.length;
}
function deeper(n: number, depth: number): number {
  const name = "d" + depth;
  if (depth === 0) return labelled(n) + name.length;
  return deeper(n, depth - 1) + name.length;
}
class Counter {
  total = 0;
  add(n: number): void {
    this.total += labelled(n);
  }
}

function caught(n: number): string {
  try {
    return "ok " + labelled(n);
  } catch (e) {
    return "caught " + (e as Error).message;
  }
}

const out: string[] = [];
for (let i = 0; i < 7; i++) out.push(caught(i));
console.log(out.join(", "));

const counter = new Counter();
let failures = 0;
for (let round = 0; round < 2000; round++) {
  for (let i = 0; i < 6; i++) {
    try {
      counter.add(i);
    } catch {
      failures++;
    }
  }
}
console.log("counter", counter.total, "failures", failures);

let deep = 0;
let deepFailures = 0;
for (let i = 0; i < 300; i++) {
  try {
    deep += deeper(i, i % 40);
  } catch (e) {
    deepFailures++;
    if (i < 10) console.log((e as Error).name, (e as Error).message);
  }
}
console.log("deep", deep, "failures", deepFailures);

const viaClosure = (n: number): number => labelled(n) + 1;
let closureFailures = 0;
for (let i = 0; i < 30; i++) {
  try {
    viaClosure(i);
  } catch {
    closureFailures++;
  }
}
console.log("closure failures", closureFailures);

function finallyOrder(n: number): string {
  const log: string[] = [];
  try {
    try {
      log.push("try");
      labelled(n);
      log.push("after");
    } finally {
      log.push("finally");
    }
  } catch (e) {
    log.push("catch " + (e as Error).message);
  }
  return log.join(" > ");
}
console.log(finallyOrder(3));
console.log(finallyOrder(4));
