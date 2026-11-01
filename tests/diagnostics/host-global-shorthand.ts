// An object shorthand read of a Node 24 global native code does not provide
// (SC2020, host-global): the property copies the global's value, where Node
// has the constructor.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: { new (url: string): HostSocket; readonly prototype: HostSocket };
const box = { WebSocket };
console.log(box.WebSocket);
