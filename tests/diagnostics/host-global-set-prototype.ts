// The value of a Node global native code does not provide, and a class
// extending one, answer `instanceof Function` as Node does, by a fold: their
// prototype chain is not one native code can walk or replace. Replacing the
// prototype would make Node answer differently, so it is a use of the
// global's surface and refuses instead of leaving the fold wrong.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };

class Sock extends WebSocket {}
class Retrying extends Sock {}
const Held = WebSocket;
console.log(Sock instanceof Function, Retrying instanceof Function, Held instanceof Function);
Object.setPrototypeOf(Sock, null);
Object.setPrototypeOf(Retrying, Function.prototype);
Object.setPrototypeOf(Held, null);
