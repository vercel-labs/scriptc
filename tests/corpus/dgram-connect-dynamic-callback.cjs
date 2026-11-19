// A connect completion callback read as an untyped value: Node calls it with
// the error when the connection is refused (process.nextTick(callback, ex))
// instead of emitting 'error', and calls it with no arguments on success.
const dgram = require("node:dgram");
const net = require("node:net");

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");
const peer = dgram.createSocket("udp4");
peer.on("message", () => {});
peer.bind(0, "127.0.0.1", () => {
  const handlers = {
    refused: (err) => {
      console.log("refused", err.code);
      const okSocket = dgram.createSocket("udp4");
      okSocket.on("error", (error) => console.log("ok error", error.code));
      okSocket.connect(peer.address().port, "127.0.0.1", handlers.connected);
      setTimeout(() => okSocket.close(), 60);
    },
    connected: () => {
      console.log("connected");
      const missingSocket = dgram.createSocket("udp4");
      missingSocket.on("error", (error) => console.log("missing error", error.code));
      missingSocket.connect(9, "nonexistent.invalid", handlers.missing);
      setTimeout(() => missingSocket.close(), 120);
    },
    missing: (err) => console.log("missing", err.code),
  };
  const refusedSocket = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
  refusedSocket.on("error", (error) => console.log("refused error", error.code));
  refusedSocket.connect(9, "127.0.0.1", handlers.refused);
  setTimeout(() => refusedSocket.close(), 200);
});
setTimeout(() => peer.close(), 300);
