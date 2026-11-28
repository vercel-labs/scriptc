// What remains OUTSIDE the type world: the standard library is es2023 only
// — no dyn, no @types/node — so host globals still fail typechecking with
// "Cannot find name" (SC0001 passthrough), exactly the old fence. (Node
// APIs the runtime does implement — process, node:fs, setTimeout, console —
// are shipped declarations, and the fallback also declares the globals real
// CLI sources reference — Buffer, fetch, setInterval, TextEncoder, ... —
// which fence at LOWERING instead: see node-fallback-fence.ts.)
queueMicrotask(() => {});
const pid = process.pid;
const cloned = structuredClone({ a: 1 });
const doc = document;
const store = localStorage;
