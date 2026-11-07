// A dgram socket passed to a function, where a JavaScript source no longer
// knows its type: the members the typed binding compiles answer the same.
// The socket options return what Node returns (undefined, or the value
// set), an unbound socket raises the same EBADF, and a value that is not a
// socket still fails with Node's "is not a function".
import dgram from "node:dgram";

/** The socket options on a parameter. */
function tune(socket) {
  console.log(socket.setRecvBufferSize(8192), socket.setSendBufferSize(8192));
  console.log(socket.getRecvBufferSize() >= 8192, socket.getSendBufferSize() >= 8192);
  console.log(socket.getSendQueueSize(), socket.getSendQueueCount());
  console.log(socket.setBroadcast(true), socket.setTTL(64));
  console.log(socket.setMulticastTTL(2), socket.setMulticastLoopback(true));
  console.log(socket.setMulticastInterface("127.0.0.1"));
}

/** A membership joined and dropped. */
function membership(socket) {
  console.log(socket.addMembership("224.0.0.114", "127.0.0.1"));
  console.log(socket.dropMembership("224.0.0.114", "127.0.0.1"));
}

/** disconnect() on a connected socket. */
function disconnect(socket) {
  console.log(socket.disconnect());
}

/** An option on an unbound socket. */
function broadcast(socket) {
  socket.setBroadcast(true);
}

await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.on("close", () => resolve());
  socket.bind(0, "127.0.0.1", () => {
    tune(socket);
    socket.close();
  });
});

await new Promise((resolve) => {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("close", () => resolve());
  socket.bind(0, "0.0.0.0", () => {
    membership(socket);
    socket.close();
  });
});

await new Promise((resolve) => {
  const peer = dgram.createSocket("udp4");
  const socket = dgram.createSocket("udp4");
  socket.on("close", () => peer.close(() => resolve()));
  peer.bind(0, "127.0.0.1", () => {
    socket.connect(peer.address().port, "127.0.0.1", () => {
      disconnect(socket);
      socket.close();
    });
  });
});

{
  const socket = dgram.createSocket("udp4");
  try {
    broadcast(socket);
  } catch (error) {
    console.log(error.code, error.syscall);
  }
  socket.close();
}

try {
  tune({});
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
