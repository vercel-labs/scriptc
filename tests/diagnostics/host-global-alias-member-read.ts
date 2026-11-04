// A member read through a constant holding the value: the alias is the same
// constructor, so the class's own static member refuses there too (SC2020,
// host-global), where Node answers WebSocket.OPEN.
declare var WebSocket: {
  new (url: string): unknown;
  readonly prototype: object;
  readonly OPEN: number;
};
const Socket = WebSocket;
console.log(Socket.OPEN);
