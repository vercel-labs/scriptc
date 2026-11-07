// A WeakRef's target that nothing else holds stays alive through the job
// that made it and through every microtask and tick that job queued: Node
// clears its kept objects only after all of them have run. Each deref keeps
// the target for its own job in turn, so the chain below never loses it.
const ref = new WeakRef({ label: "fresh", uses: 0 });

function use(where: string): void {
  const target = ref.deref();
  if (target !== undefined) target.uses++;
  console.log(where, target?.label, target?.uses);
}

// The same for a target that is a plain object to the runtime, with no
// typed record behind it: parsed JSON nothing else holds.
const parsed = new WeakRef(JSON.parse('{"label":"parsed"}') as object);
function see(where: string): void {
  console.log(where, JSON.stringify(parsed.deref()));
}

queueMicrotask(() => see("microtask"));
void Promise.resolve().then(() => see("then"));
process.nextTick(() => see("tick"));
void (async () => {
  await null;
  see("await");
  await Promise.resolve();
  see("await again");
})();
see("sync");

queueMicrotask(() => use("microtask"));
void Promise.resolve().then(() => use("then"));
process.nextTick(() => use("tick"));
void (async () => {
  await null;
  use("await");
  await Promise.resolve();
  use("await again");
  queueMicrotask(() => use("nested microtask"));
})();
use("sync");
