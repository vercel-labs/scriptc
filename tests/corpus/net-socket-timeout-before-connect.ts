// setTimeout() on a constructed socket survives until the dial: the value is
// kept while there is no descriptor, the timer starts when the connection
// starts, and a peer that accepts but never answers trips it.
import * as net from "node:net";

const server = net.createServer((peer) => {
  /* accepts, sends nothing */
  peer.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address() as net.AddressInfo;
  const socket = new net.Socket();
  socket.setTimeout(30);
  socket.on("timeout", () => {
    console.log("timeout", socket.timeout, socket.destroyed);
    socket.destroy();
  });
  socket.on("error", (error: Error & { code?: string }) => console.log("error", error.code));
  socket.on("close", () => {
    console.log("closed", socket.destroyed);
    server.close();
  });
  socket.connect(address.port, "127.0.0.1");
});
