// An options getter that throws aborts the bind: the socket must not bind
// behind the exception.
const dgram = require("node:dgram");

const socket = dgram.createSocket("udp4");
const options = { port: 0 };
Object.defineProperty(options, "address", {
  get() {
    throw new Error("getter threw");
  },
  enumerable: true,
});

let outcome = "bound";
try {
  socket.bind(options);
} catch (err) {
  outcome = `threw ${err.message}`;
}
console.log("bind", outcome);
socket.close();
