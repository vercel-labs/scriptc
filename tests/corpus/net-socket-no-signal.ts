// A socket constructed without a signal must not reference the
// abort-listener machinery it cannot use: this program holds no
// AbortController at all, so a reference to that runtime unit would fail
// the native link. Both the bare form and an options literal without a
// signal dial like Node.
import * as net from "node:net";

const server = net.createServer((peer) => {
  peer.on("error", () => {});
  peer.end("ok");
});

const round = (socket: net.Socket, done: () => void): void => {
  socket.on("data", (chunk: Buffer) => console.log("data", chunk.toString()));
  /* the half-open client ends its own write side when the peer's FIN lands */
  socket.on("end", () => socket.end());
  socket.on("error", () => {});
  socket.on("close", () => {
    console.log("closed", socket.destroyed, socket.allowHalfOpen);
    done();
  });
};

server.listen(0, "127.0.0.1", () => {
  const address = server.address() as net.AddressInfo;
  const bare = new net.Socket();
  round(bare, () => {
    const literal = new net.Socket({ allowHalfOpen: true });
    round(literal, () => {
      server.close();
    });
    literal.connect(address.port, "127.0.0.1");
  });
  bare.connect(address.port, "127.0.0.1");
});
