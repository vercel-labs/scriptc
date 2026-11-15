// The state of a promise kept beside it, not on it: a wrapper record made
// once where the promise enters, and a WeakMap keyed by the promise. Both
// answer the same questions a status written onto the promise would, for
// promises that fulfil, reject and stay pending, and the reads never wait.
type State<T> =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

interface Tracked<T> {
  readonly promise: Promise<T>;
  state: State<T>;
}

function wrap<T>(promise: Promise<T>): Tracked<T> {
  const tracked: Tracked<T> = { promise, state: { status: "pending" } };
  promise.then(
    (value) => {
      tracked.state = { status: "fulfilled", value };
    },
    (reason: unknown) => {
      tracked.state = { status: "rejected", reason };
    },
  );
  return tracked;
}

const states = new WeakMap<Promise<number>, State<number>>();

function track(promise: Promise<number>): State<number> {
  const known = states.get(promise);
  if (known !== undefined) return known;
  const pending: State<number> = { status: "pending" };
  states.set(promise, pending);
  promise.then(
    (value) => {
      states.set(promise, { status: "fulfilled", value });
    },
    (reason: unknown) => {
      states.set(promise, { status: "rejected", reason });
    },
  );
  return pending;
}

function show<T>(state: State<T>): string {
  if (state.status === "fulfilled") return "fulfilled " + String(state.value);
  if (state.status === "rejected")
    return "rejected " + (state.reason instanceof Error ? state.reason.message : String(state.reason));
  return "pending";
}

class Suspended {
  readonly wakeable: Promise<unknown>;
  constructor(wakeable: Promise<unknown>) {
    this.wakeable = wakeable;
  }
}

function read(promise: Promise<number>): number {
  const state = track(promise);
  if (state.status === "fulfilled") return state.value;
  if (state.status === "rejected") throw state.reason;
  throw new Suspended(promise);
}

async function attempt(label: string, compute: () => number): Promise<void> {
  for (let tries = 1; tries <= 3; tries += 1) {
    try {
      console.log(label, "ok", compute(), "tries", tries);
      return;
    } catch (thrown) {
      if (thrown instanceof Suspended) {
        console.log(label, "suspended");
        await thrown.wakeable.then(
          () => undefined,
          () => undefined,
        );
      } else {
        console.log(label, "failed", thrown instanceof Error ? thrown.message : String(thrown));
        return;
      }
    }
  }
}

async function main(): Promise<void> {
  const quick = Promise.resolve(41);
  const failing: Promise<number> = Promise.reject(new Error("no value"));
  const never = new Promise<number>(() => undefined);

  const wrapped = [wrap(quick), wrap(failing), wrap(never)];
  const words = wrap(Promise.resolve("text"));
  console.log("wrapped at once:", wrapped.map((entry) => show(entry.state)).join(", "));
  await Promise.resolve();
  await Promise.resolve();
  console.log("wrapped later:", wrapped.map((entry) => show(entry.state)).join(", "), "|", show(words.state));
  console.log("the wrapper keeps the promise:", wrapped[0]!.promise === quick, await wrapped[0]!.promise);

  await attempt("quick", () => read(quick) + 1);
  await attempt("failing", () => read(failing));
  console.log("tracked:", show(track(quick)), "|", show(track(failing)), "|", show(track(never)));
  console.log("keys:", states.has(quick), states.has(failing), states.has(never), states.has(Promise.resolve(41)));
}

main();
