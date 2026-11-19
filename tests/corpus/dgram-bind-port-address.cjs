// bind(port, address) with an untyped JavaScript port: the address stays
// the address, not a callback.
const dgram = require("node:dgram");

const socket = dgram.createSocket("udp4");
const port = 0;
socket.bind(port, "127.0.0.1", () => {
  const bound = socket.address();
  console.log("bound", bound.address, bound.family, bound.port > 0);
  socket.close();
});
