// A socket type read from a variable is checked at run time: a value that is
// not "udp4" or "udp6" throws Node's ERR_SOCKET_BAD_TYPE, a valid one builds
// the socket.
const dgram = require("node:dgram");

for (const type of ["udp7", "udp4", "UDP4", ""]) {
  try {
    const socket = dgram.createSocket(type);
    console.log("created", JSON.stringify(type), socket.type);
    socket.close();
  } catch (err) {
    console.log("refused", JSON.stringify(type), err.code, err.message);
  }
}
