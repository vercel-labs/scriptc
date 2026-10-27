// A synchronous generator has no AsyncLocalStorage context of its own: each
// step runs in its resumer's execution, so it sees the store current at
// that next() call, and a store it enters is the resumer's after the step.
// Covers steps inside and outside run(), for-of, spread and early return.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const current = (): string => store.getStore() ?? "none";

function* steps(): Generator<string, void, undefined> {
  console.log(`start sees ${current()}`);
  yield "a";
  console.log(`step 2 sees ${current()}`);
  store.enterWith("entered-in-step-2");
  yield "b";
  console.log(`step 3 sees ${current()}`);
}

function* labels(): Generator<string, void, undefined> {
  yield current();
  yield current();
}

store.run("S1", () => {
  const g = steps();
  g.next();
  store.run("S2", () => g.next());
  console.log(`caller after the S2 step: ${current()}`);
  store.enterWith("S3");
  g.next();
  console.log(`caller after step 3: ${current()}`);
});

store.run("forof", () => {
  const seen: string[] = [];
  for (const label of labels()) seen.push(label);
  console.log(`for-of: ${seen.join(",")}`);
  console.log(`spread: ${[...labels()].join(",")}`);
});

store.run("outer", () => {
  const g = steps();
  g.next();
  g.next();
  console.log(`caller after entering step: ${current()}`);
  g.return();
  console.log(`caller after return: ${current()}`);
});
console.log(`top level: ${current()}`);
