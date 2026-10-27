// Rejections through maybe-promise values: a rejected promise arm throws at
// the await, a synchronous throw never reaches the await, an async return
// adopts the promise arm (so its rejection settles the caller's promise
// after the function's own handlers), and a `Promise<void> | void`
// callback's promise is adopted by an async function returning it.

type MaybeBool = boolean | Promise<boolean>;
function check(kind: number): MaybeBool {
  if (kind === 0) return true;
  if (kind === 1) return Promise.reject(new Error("rejected " + kind));
  if (kind === 2) throw new Error("thrown " + kind);
  return Promise.resolve(false);
}

async function awaitEach(): Promise<void> {
  for (let kind = 0; kind < 4; kind++) {
    try {
      console.log(kind, await check(kind));
    } catch (e) {
      console.log(kind, "caught", (e as Error).message);
    }
  }
}

// `return check(1)` inside try/catch/finally: JS completes the return first
// (the finally runs), and only then does the async function's promise adopt
// the rejected arm, so this function's own catch never sees it.
async function returnInTry(kind: number): Promise<boolean> {
  try {
    return check(kind);
  } catch (e) {
    console.log("inner catch", (e as Error).message);
    return false;
  } finally {
    console.log("finally", kind);
  }
}

type Callback = () => Promise<void> | void;
const callbacks: Callback[] = [
  () => {
    console.log("sync callback");
  },
  async () => {
    throw new Error("async callback failed");
  },
];
async function runCallback(cb: Callback): Promise<void> {
  return cb();
}

async function main(): Promise<void> {
  await awaitEach();
  for (const kind of [0, 1, 2]) {
    try {
      console.log("returned", await returnInTry(kind));
    } catch (e) {
      console.log("outer catch", (e as Error).message);
    }
  }
  for (const cb of callbacks) {
    try {
      await runCallback(cb);
      console.log("callback ok");
    } catch (e) {
      console.log("callback caught", (e as Error).message);
    }
  }
  // A then handler returning a rejected promise arm rejects the chain.
  await Promise.resolve(1)
    .then(() => check(1))
    .then(
      (v) => console.log("then value", v),
      (e: Error) => console.log("then rejected", e.message),
    );
}
main();
