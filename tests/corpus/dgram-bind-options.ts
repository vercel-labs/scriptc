// bind() and bind(options[, callback]) as Node normalizes them: the
// wildcard default, the typed options record, the callback registered as
// a once('listening') listener, and the argument ladder of the options
// address.
import * as dgram from "node:dgram";

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.bind();
  socket.on("listening", () => {
    const address = socket.address();
    console.log("bind()", address.address, address.family, typeof address.port);
    socket.close();
  });
  socket.on("close", () => resolve());
});

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp4");
  const options = { port: 0, address: "127.0.0.1", exclusive: true };
  socket.bind(options, () => {
    const address = socket.address();
    console.log("bind(options, cb)", address.address, address.family, typeof address.port);
    socket.close();
  });
  socket.on("close", () => resolve());
});

