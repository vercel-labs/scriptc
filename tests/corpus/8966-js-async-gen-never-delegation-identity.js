// `yield*` over a delegate that never yields (its element type is `never`):
// the delegation protocol still runs. The delegate's steps, its thrown error
// and its completion are the whole of the delegation, so a throw reaches the
// consumer's rejection handler as the same error object, a catch inside the
// generator sees the same object, a return completion completes the
// generator, and a delegate that does yield (a valued channel) forwards each
// step before it throws.
function log(...parts) {
  console.log(parts.map((p) => String(p)).join(" "));
}

const e1 = new Error("boom");

/** @returns {Generator<never, void, unknown>} */
function* throwsOnly() {
  throw e1;
}

/** @returns {Generator<never, string, unknown>} */
function* returnsOnly() {
  return "ret";
}

/** @returns {Generator<number, void, unknown>} */
function* yieldsThenThrows() {
  yield 1;
  throw e1;
}

/** @returns {AsyncGenerator<never, void, unknown>} */
async function* delegateThrows() {
  yield* throwsOnly();
}

/** @returns {AsyncGenerator<never, void, unknown>} */
async function* delegateCatches() {
  try {
    yield* throwsOnly();
  } catch (e) {
    log("catch", e === e1, e.message);
    throw e;
  }
}

/** @returns {AsyncGenerator<never, void, unknown>} */
async function* delegateReturns() {
  yield* returnsOnly();
}

/** @returns {AsyncGenerator<number, void, unknown>} */
async function* delegateSteps() {
  yield* yieldsThenThrows();
}

/** @returns {Generator<never, void, unknown>} */
function* syncDelegates() {
  yield* throwsOnly();
}

async function main() {
  await delegateThrows()
    .next()
    .then(
      () => log("throws resolved"),
      (e) => log("throws rejected", e === e1, e.message),
    );
  await delegateCatches()
    .next()
    .then(
      () => log("catches resolved"),
      (e) => log("catches rejected", e === e1, e.message),
    );
  await delegateReturns()
    .next()
    .then((r) => log("returns", r.done, r.value));
  const steps = delegateSteps();
  await steps.next().then((r) => log("step", r.done, r.value));
  await steps.next().then(
    () => log("steps resolved"),
    (e) => log("steps rejected", e === e1, e.message),
  );
  try {
    syncDelegates().next();
    log("sync returned");
  } catch (e) {
    log("sync threw", e === e1, e.message);
  }
  log("done");
}

main();
