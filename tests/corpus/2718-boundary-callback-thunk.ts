// @dynamic
// 2718 boundary callback thunk — the EventEmitter-style dynamic-lib
// boundary (database.ts:36 dbPool.on('error')): a statically-typed
// (Error / any) callback crosses into dynamically-executed code. The
// 'any'-typed receiver is the mock boundary (node:events lowers
// statically, so it never crosses); the error travels in its dynamic
// encoding, and the typed handler's boundary thunk rebuilds it.
const dbPool: any = JSON.parse("{}");
let captured = "";
const boom: unknown = new Error("boom");
dbPool.on = (ev: any, cb: any): void => {
  cb(boom);
};
dbPool.on("error", (err: Error) => {
  captured = err.message;
});
console.log(captured);

// second variant: any-param boundary — 'any' params stay engine handles;
// the handler reads back through the engine (database.ts:36's err shape).
const holder: any = JSON.parse("{}");
let anyCap = "";
const boomAny: unknown = new Error("any-err");
holder.invoke = (cb: any): void => {
  cb(boomAny);
};
holder.invoke((err: any) => {
  anyCap = err?.message ?? String(err);
});
console.log(anyCap);
