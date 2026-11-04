// The project declares the global the way @types/node does; typeof it is
// still a read of a Node 24 global native code does not provide (SC2020,
// host-global), where Node answers "function".
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };
console.log(typeof WebSocket);
