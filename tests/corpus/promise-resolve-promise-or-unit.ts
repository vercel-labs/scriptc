// `Promise.resolve(u)` over a promise-or-unit union (`Promise<void> |
// void`): Node adopts a promise operand — the SAME promise comes
// back — and fulfills a nullish one as undefined. The settled turn of the
// adopted promise is unchanged, so a handler chain observes the same
// microtask order either way.

let runs = 0;

async function step(label: string): Promise<void> {
  runs++;
  await Promise.resolve();
  console.log("step", label, runs);
}

// A callback whose declared result is `Promise<void> | void`: the
// async path answers a promise, the sync one answers undefined.
function handler(flag: boolean): Promise<void> | void {
  if (flag) return step("async");
  runs++;
  console.log("sync handler", runs);
}

function call(flag: boolean): Promise<void> {
  return Promise.resolve(handler(flag)).then(() => console.log("call done", flag));
}

const pending: Promise<void> | void = Promise.resolve();
console.log("identity", Promise.resolve(pending) === pending);

console.log("start");
call(true)
  .then(() => call(false))
  .then(() => call(true))
  .then(() => console.log("runs", runs));
