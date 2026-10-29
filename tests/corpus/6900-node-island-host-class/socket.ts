/// <reference path="./globals.d.ts" />
// A class whose base only the JavaScript runtime has (the census's
// `class extends WebSocket` shape): native lowering cannot extend it, so
// this module runs in a Node island automatically (R1.6) and the entry
// stays native. Nothing connects: the program reads the class itself.
export class Socket extends WebSocket {
  static tag = "socket";
}

export function describeSocket(): string {
  return `${Socket.tag}:${Object.getPrototypeOf(Socket) === WebSocket}`;
}
