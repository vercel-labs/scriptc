// A string-keyed read off a cast of the global object is the same read as
// `globalThis.WebSocket` (Node answers "function"), so it refuses instead of
// answering undefined through the dynamic global path. SC2020, host-global.
const pattern = (globalThis as unknown as Record<string, unknown>)["URLPattern"];
console.log(typeof pattern);
