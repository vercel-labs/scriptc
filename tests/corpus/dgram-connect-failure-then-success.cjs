// A failed connect answers its completion once and removes it: a later
// successful connect on the same socket runs only the new callback.
const dgram = require("node:dgram");

const peer = dgram.createSocket("udp4");
peer.on("message", () => {});
peer.bind(0, "127.0.0.1", () => {
  const handler = { done: (err) => console.log("callback", err ? err.code : "connected") };
  const socket = dgram.createSocket("udp4");
  socket.connect(9, "nonexistent.invalid", handler.done);
  setTimeout(() => {
    socket.connect(peer.address().port, "127.0.0.1", handler.done);
    setTimeout(() => {
      socket.close();
      peer.close();
    }, 60);
  }, 60);
});
