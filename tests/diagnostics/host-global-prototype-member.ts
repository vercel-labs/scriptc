// A method read off the value's prototype object: Node's class provides its
// instance methods there (WebSocket.prototype.send), which native code does
// not; the prototype carries the constructor link only (SC2020,
// host-global).
interface HostSocket {
  send(data: string): void;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };
WebSocket.prototype.send("value");
