// Checked dynamic values can be narrowed to a socket-shaped value at an
// explicit cast boundary before reading its remote address.
function getRemoteIp(req: any): string { return req.socket?.remoteAddress || "127.0.0.1"; }
console.log(getRemoteIp({ socket: { remoteAddress: "10.0.0.1" } }));
console.log(getRemoteIp({ socket: null }));
console.log(getRemoteIp({} as any));

function getIpValidated(req: any) {
  const sock = req.socket as {remoteAddress:string};
  return sock?.remoteAddress ?? "unknown";
}
console.log(getIpValidated({ socket: {remoteAddress:"1.2.3.4"} }));
