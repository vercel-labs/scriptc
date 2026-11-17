// A membership call on an unbound socket implicit-binds it: the address
// answers at once, and the socket then behaves like any bound one (its
// close path runs).
import * as dgram from "node:dgram";

const socket = dgram.createSocket("udp4");
socket.addMembership("224.0.0.114", "127.0.0.1");
const bound = socket.address();
console.log("bound", bound.address, bound.family, bound.port > 0);

await new Promise<void>((resolve) => {
  socket.on("close", () => console.log("close"));
  socket.close(() => {
    console.log("callback");
    resolve();
  });
});
