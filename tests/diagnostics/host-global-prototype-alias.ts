// A method read through a constant holding the value's prototype object: the
// alias is the same prototype, so the class's instance method refuses there
// too (SC2020, host-global), where Node's WebSocket.prototype carries send.
interface HostSocket {
  send(data: string): void;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };
const body = WebSocket.prototype;
body.send("value");
