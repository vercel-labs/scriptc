// Node 24 defines the Web Storage globals only under the
// --experimental-webstorage flag (the globals chapter marks each "Enable this
// API with --experimental-webstorage"), so a default Node process and a
// scriptc binary agree that they are absent.
console.log(typeof localStorage, typeof sessionStorage, typeof Storage);
console.log(globalThis.localStorage === undefined, globalThis.sessionStorage === undefined);
console.log("localStorage" in globalThis, "Storage" in globalThis);
