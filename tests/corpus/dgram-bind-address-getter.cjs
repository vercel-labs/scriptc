// bind(options): the address comes from a property read, so a getter runs
// and the socket binds the address it answers.
const dgram = require("node:dgram");

const socket = dgram.createSocket("udp4");
const options = { port: 0 };
let reads = 0;
Object.defineProperty(options, "address", {
  get() {
    reads += 1;
    return "127.0.0.1";
  },
  enumerable: true,
});

socket.bind(options, () => {
  const bound = socket.address();
  console.log("address", bound.address, bound.family, reads > 0);
  socket.close();
});
