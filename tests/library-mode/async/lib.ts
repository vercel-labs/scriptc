// K15 fixture: async functions in the library graph, and the host-driven
// job checkpoint that lets their continuations run.
//
// The host owns time. Nothing here reads a clock, arms a timer, or asks
// for a loop: `awaitHost` hands the pending resolve to module state and
// parks, the HOST decides when to settle it (`settle`), and the profile's
// drain entry decides when the continuation actually runs. Every line the
// library emits goes out through the `emit` channel, so the probe can
// assert exactly what had happened at each point.
declare function emit(line: string): void;

let pending: ((value: string) => void) | null = null;
let finished = 0;

// The host-owned await: park on a promise only `settle` can resolve.
function awaitHost(tag: string): Promise<string> {
  return new Promise<string>((resolve) => {
    pending = resolve;
    emit(`parked ${tag}`);
  });
}

async function handle(label: string): Promise<void> {
  emit(`enter ${label}`);
  const a = await awaitHost("a");
  emit(`${label} resumed ${a}`);
  const b = await awaitHost("b");
  emit(`${label} done ${a}${b}`);
  finished = finished + 1;
}

// Starts an async handler. Its SYNCHRONOUS prefix runs here (JS's rule),
// so the return value must still see finished == 0.
export function start(label: string): number {
  void handle(label);
  return finished;
}

// The narrowest half of the report: a bare `Promise.resolve().then()`.
// Queued here, run at the next drain — never at some later program exit.
export function schedule(): number {
  Promise.resolve("m").then((v) => {
    emit(`microtask ${v}`);
  });
  emit("scheduled");
  return finished;
}

// The host settles the parked promise. Settling QUEUES the continuation;
// it does not run it — that is the drain's job, and the return value
// proves the difference.
export function settle(value: string): number {
  const resolve = pending;
  if (resolve === null) return -1;
  pending = null;
  resolve(value);
  return finished;
}

export function done(): number {
  return finished;
}

emit("async library ready");
