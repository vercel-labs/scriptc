// socket.connect() with no arguments throws Node's ERR_MISSING_ARGS at the
// call — a JavaScript-only shape, since the typed overloads require an
// argument.
import * as net from "node:net";

const socket = new net.Socket();
try {
  socket.connect();
  console.log("connect", "accepted");
} catch (err) {
  console.log("connect", err.code, JSON.stringify(err.message));
}
socket.destroy();
