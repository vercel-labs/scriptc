// dgram.Socket members beyond bind, send and close: the 'listening',
// 'message' and 'close' events, the receive and send buffer sizes, the
// send queue counters, broadcast and TTL, and the multicast options with
// a membership joined and dropped. Each socket is created and used in one
// scope and closed before the next section starts.
import dgram from "node:dgram";

await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.on("listening", () => {
    console.log("listening", typeof socket.address().port);
    socket.close();
  });
  socket.on("close", () => {
    console.log("close");
    resolve(undefined);
  });
  socket.bind(0, "127.0.0.1");
});

await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.on("close", () => resolve(undefined));
  socket.on("message", (message, remote) => {
    console.log("message", String(message), remote.address, remote.family, remote.size);
    socket.close();
  });
  socket.bind(0, "127.0.0.1", () => socket.send("hi", socket.address().port, "127.0.0.1"));
});

await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.on("close", () => resolve(undefined));
  socket.bind(0, "127.0.0.1", () => {
    socket.setRecvBufferSize(8192);
    socket.setSendBufferSize(8192);
    console.log(socket.getRecvBufferSize() >= 8192, socket.getSendBufferSize() >= 8192);
    console.log(socket.getSendQueueSize(), socket.getSendQueueCount());
    socket.setBroadcast(true);
    console.log(socket.setTTL(64));
    console.log(socket.setMulticastTTL(2), socket.setMulticastLoopback(true));
    socket.setMulticastInterface("127.0.0.1");
    socket.close();
  });
});

await new Promise((resolve) => {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("close", () => resolve(undefined));
  socket.bind(0, () => {
    socket.addMembership("224.0.0.114", "127.0.0.1");
    socket.dropMembership("224.0.0.114", "127.0.0.1");
    console.log("membership joined and dropped");
    socket.close();
  });
});
