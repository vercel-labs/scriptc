// The project declares the global the way @types/node does; calling the
// constructor value refuses for the same reason constructing it does: the
// call can only produce an instance native code does not have (SC2020,
// host-global), where Node throws its class-call TypeError.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: {
  new (url: string): HostSocket;
  (url: string): HostSocket;
  readonly prototype: HostSocket;
};
const socket = WebSocket("ws://localhost:8080");
console.log(socket.readyState);
