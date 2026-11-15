// A WeakMap and a WeakSet keyed by promises. The key is the promise itself,
// however the program holds it: through its typed binding, as a parameter of
// a wider promise type, as an unknown value told apart with instanceof, in an
// object-typed collection, before and after it settles. Two promises are two
// keys, and entries whose promises are gone do not disturb the ones that
// stay.
type State =
  | { readonly status: "pending" }
  | { readonly status: "done"; readonly value: number }
  | { readonly status: "failed"; readonly reason: string };

const states = new WeakMap<Promise<number>, State>();
const visited = new WeakSet<Promise<unknown>>();
const labels = new WeakMap<object, string>();

function track(job: Promise<number>): State {
  const known = states.get(job);
  if (known !== undefined) return known;
  const pending: State = { status: "pending" };
  states.set(job, pending);
  job.then(
    (value) => {
      states.set(job, { status: "done", value });
    },
    (reason: unknown) => {
      states.set(job, { status: "failed", reason: reason instanceof Error ? reason.message : String(reason) });
    },
  );
  return pending;
}

function show(state: State | undefined): string {
  if (state === undefined) return "untracked";
  if (state.status === "done") return "done " + state.value;
  if (state.status === "failed") return "failed " + state.reason;
  return "pending";
}

function visit(job: Promise<unknown>): boolean {
  const before = visited.has(job);
  visited.add(job);
  return before;
}

function label(value: unknown, text: string): string {
  if (value instanceof Promise) {
    const known = labels.get(value);
    if (known !== undefined) return "already " + known;
    labels.set(value, text);
    return "labelled " + text;
  }
  return "not a promise";
}

async function compute(n: number): Promise<number> {
  return n * 2;
}

function later(n: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(n), 1);
  });
}

function churn(rounds: number): number {
  const kept: Promise<number>[] = [];
  for (let i = 0; i < rounds; i++) {
    const job = Promise.resolve(i);
    states.set(job, { status: "done", value: i });
    visited.add(job);
    if (i % 100 === 0) kept.push(job);
  }
  let found = 0;
  for (const job of kept) {
    const state = states.get(job);
    if (state !== undefined && state.status === "done" && visited.has(job)) found += 1;
  }
  return found;
}

async function main(): Promise<void> {
  const quick = Promise.resolve(41);
  const other = Promise.resolve(41);
  const slow = later(7);
  const made = compute(4);
  const failing: Promise<number> = Promise.reject(new Error("no value"));

  console.log("first", show(track(quick)), show(track(slow)), show(track(made)), show(track(failing)));
  console.log("same key", track(quick) === track(quick), states.has(quick), states.has(other));
  console.log("typed and wider", visit(quick), visit(quick), visited.has(quick), visited.has(other));
  console.log("unknown", label(quick, "quick"), label(quick, "again"), label(other, "other"), label(7, "seven"));
  console.log("object key", labels.has(quick), labels.get(other) ?? "missing", labels.has(slow));

  await slow;
  console.log("settled", show(states.get(quick)), show(states.get(slow)), show(states.get(made)), show(states.get(failing)));
  console.log("after the await", states.has(slow), visited.has(quick), labels.get(quick) ?? "missing");

  console.log("delete", states.delete(other), states.delete(quick), states.has(quick), states.delete(quick));
  console.log("weak set delete", visited.delete(quick), visited.has(quick), visited.delete(quick));
  console.log("tracked again", show(track(quick)));
  await quick;
  console.log("and settled", show(states.get(quick)));

  console.log("churn", churn(1000), churn(300), states.has(slow), show(states.get(made)));
}

main();
