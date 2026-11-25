// A member read off a Node 24 global native code does not provide: the
// constructor value carries name, length and prototype, and the class's own
// static members are surface native code does not have (SC2020,
// host-global), where Node answers WebSocket.OPEN.
declare var WebSocket: {
  new (url: string): unknown;
  readonly prototype: object;
  readonly OPEN: number;
};
console.log(WebSocket.OPEN);
