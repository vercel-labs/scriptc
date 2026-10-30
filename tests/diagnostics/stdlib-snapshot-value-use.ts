// The snapshot's declaration emits no storage: only reads that resolve
// THROUGH the global (members, calls) can exist. A read that needs the
// value reports the declaration's cause — the binding, the global it
// snapshots and why neither holds a value — and the use site carries the
// inherited-blocker cascade instead of "a binding form with no lowering".
function label(): unknown {
  const proc = globalThis.process;
  return proc;
}
console.log(label());
