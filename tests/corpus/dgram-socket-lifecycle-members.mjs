// The class row's remaining members: construction through the class, the
// chainable ref/unref, connect()'s 'connect' event, remoteAddress after a
// synchronous connect, disconnect's reset, the send queue counters and
// Symbol.asyncDispose.
import dgram from "node:dgram";

const socket = new dgram.Socket({ type: "udp4" });
console.log("class", socket instanceof dgram.Socket, dgram.Socket.name, typeof dgram.Socket);
console.log("chainable", socket.ref() === socket, socket.unref() === socket);
console.log("queue", socket.getSendQueueSize(), socket.getSendQueueCount());
console.log("type", socket.type);

const peer = dgram.createSocket("udp4");
await new Promise((resolve) => peer.bind(0, "127.0.0.1", resolve));
const peerPort = peer.address().port;
console.log("peer type", peer.type);

await new Promise((resolve) => {
  let connects = 0;
  socket.on("connect", () => {
    connects += 1;
    const remote = socket.remoteAddress();
    console.log(
      "connect event",
      connects,
      remote.address,
      remote.family,
      remote.port === peerPort,
    );
    console.log("queue connected", socket.getSendQueueSize(), socket.getSendQueueCount());
    socket.send(Buffer.from("hi"), (err) =>
      console.log("send callback", err ? err.code : "ok"),
    );
  });
  peer.on("message", (message, remote) => {
    console.log("peer received", String(message), remote.address, remote.port === socket.address().port);
    socket.disconnect();
    try {
      socket.remoteAddress();
    } catch (err) {
      console.log("after disconnect", err.code, err.message);
    }
    console.log("queue after", socket.getSendQueueSize(), socket.getSendQueueCount());
    resolve();
  });
  socket.connect(peerPort, "127.0.0.1");
});

// A synchronous connect reports the same address through remoteAddress.
const sync = dgram.createSocket("udp4");
sync.bindSync({ port: 0, address: "127.0.0.1" });
console.log("sync bound", sync.address().port > 0, sync.address().address);
sync.connectSync(peerPort, "127.0.0.1");
console.log("connectSync remote", sync.remoteAddress().port === peerPort, sync.remoteAddress().family);
sync.disconnect();

const disposed = dgram.createSocket("udp4");
disposed.bindSync({ port: 0, address: "127.0.0.1" });
await disposed[Symbol.asyncDispose]();
console.log("asyncDispose closed");
try {
  disposed.address();
} catch (err) {
  console.log("disposed address", err.code);
}
try {
  disposed.send("x", 1, "127.0.0.1");
} catch (err) {
  console.log("disposed send", err.code);
}

peer.close();
sync.close();
