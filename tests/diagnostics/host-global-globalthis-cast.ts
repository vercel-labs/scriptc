// A Node 24 global read through a cast of the global object answers the
// constructor, so constructing it refuses instead of failing on an undefined
// callee (SC2020, host-global) — the module belongs in a Node island instead.
const socket = new (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket(
  "ws://localhost:8080",
);
console.log(socket);
