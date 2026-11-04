// A Node 24 global read through a cast of the global object: Node has the
// constructor, so a native build must not answer undefined (SC2020,
// host-global) — the module belongs in a Node island instead.
const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
console.log(typeof ctor);
