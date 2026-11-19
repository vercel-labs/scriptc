// send's completion-callback form from a typed source: the callback
// receives (null, bytes) on the turn after the send, before the peer's
// 'message' delivery, and the socket stays usable.
import * as dgram from "node:dgram";

await new Promise<void>((resolve) => {
  const peer = dgram.createSocket("udp4");
  peer.on("message", (msg) => {
    console.log("peer", String(msg));
    peer.close();
  });
  peer.bind(0, "127.0.0.1", () => {
    const socket = dgram.createSocket("udp4");
    socket.send("hi", peer.address().port, "127.0.0.1", (err, bytes) => {
      console.log("callback", err, bytes);
      socket.close();
      resolve();
    });
    console.log("sent");
  });
});
