// A promise that is thrown, or that is the reason of a rejection, is still
// that promise where it is caught: it has a `then`, it is an instance of
// Promise, it can be awaited, and it is the object that was thrown (a key
// of a WeakMap, equal to the original). A loader that is not ready throws
// the promise it waits for, and the caller waits for it and tries again.
let tick = 0;
function spin(i: number): void {
  if (i < 12) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

const loaded = new Map<string, string>();
const loading = new Map<string, Promise<void>>();
const waits = new WeakMap<object, string>();

function load(name: string): string {
  const ready = loaded.get(name);
  if (ready !== undefined) return ready;
  let pending = loading.get(name);
  if (pending === undefined) {
    pending = Promise.resolve().then(() => {
      loaded.set(name, name.toUpperCase());
    });
    loading.set(name, pending);
    waits.set(pending, name);
  }
  throw pending;
}

async function render(name: string): Promise<string> {
  for (let tries = 1; tries <= 3; tries += 1) {
    try {
      return load(name) + " after " + tries + " tries";
    } catch (thrown) {
      if (!isThenable(thrown)) throw thrown;
      console.log(
        "  suspended:",
        typeof thrown,
        thrown instanceof Promise,
        thrown === loading.get(name),
        waits.get(thrown) ?? "unknown wait",
        "tick",
        tick,
      );
      await thrown;
    }
  }
  return "gave up";
}

function describe(label: string, value: unknown): void {
  console.log(label + ":", typeof value, isThenable(value), value instanceof Promise);
}

class Stopped extends Error {}

async function main(): Promise<void> {
  spin(0);
  console.log(await render("alpha"), "tick", tick);
  console.log(await render("alpha"), "tick", tick);

  const original = Promise.resolve(5);
  try {
    throw original;
  } catch (caught) {
    describe("thrown", caught);
    console.log("the same promise:", caught === original, caught instanceof Promise ? await caught : "not awaited");
  }

  const made = (async (): Promise<number> => 6)();
  try {
    await Promise.reject(made);
  } catch (reason) {
    describe("rejection reason", reason);
    console.log("the same promise:", reason === made, reason instanceof Promise ? await reason : "not awaited");
  }

  try {
    await (async (): Promise<void> => {
      throw original;
    })();
  } catch (caught) {
    describe("thrown in an async function", caught);
  }

  try {
    throw new Stopped("stopped");
  } catch (caught) {
    describe("an error", caught);
  }
  console.log("end tick", tick);
}

main();
