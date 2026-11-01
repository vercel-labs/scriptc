// lib.dom and @types/node declare the global twice — the interface beside the
// `declare var`. typeof is still a read of a Node 24 global native code does
// not provide (SC2020, host-global), where Node answers "function".
declare var WebSocket: { new (url: string): WebSocket; readonly prototype: WebSocket };
interface WebSocket {
  readonly readyState: number;
}
if (typeof WebSocket === "function") console.log("has WebSocket");
else console.log("no WebSocket");
