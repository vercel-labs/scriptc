// A bare read of a Node 24 global the project declares ambiently (the
// @types/node shape) answers Node's constructor, which refuses construction:
// native code can never produce the instance (SC2020, host-global).
declare var WebSocket: { new (url: string): unknown };
const socket = new WebSocket("ws://localhost:8080");
console.log(socket);
