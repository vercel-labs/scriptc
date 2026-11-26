// socket.bind(null): Node's normalizeArgs reads a null first argument as
// the port value, and validatePort turns it into 0 — the wildcard port a
// bare bind() uses, not the object form's TypeError that bindSync raises.
import * as dgram from "node:dgram";

const socket = dgram.createSocket("udp4");
socket.on("error", (err) => {
  console.log("error", err.code, err.message);
  socket.close();
});
socket.bind(null, () => {
  const { address, family, port } = socket.address();
  console.log("bound", family, address, port > 0 ? "port" : "no-port");
  socket.close(() => console.log("closed"));
});
