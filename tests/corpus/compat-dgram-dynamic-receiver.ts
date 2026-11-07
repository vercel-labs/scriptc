// A dgram socket seen through no type: the members its typed binding
// compiles answer the same through `any` and `unknown`. The socket options
// return what Node returns (undefined, or the value set), an unbound
// socket raises the same EBADF, and a value that is not a socket still
// fails with Node's "is not a function".
import * as dgram from "node:dgram";

/** The socket options through `any`. */
function tune(socket: any): void {
  console.log(socket.setRecvBufferSize(8192), socket.setSendBufferSize(8192));
  console.log(socket.getRecvBufferSize() >= 8192, socket.getSendBufferSize() >= 8192);
  console.log(socket.getSendQueueSize(), socket.getSendQueueCount());
  console.log(socket.setBroadcast(true), socket.setTTL(64));
  console.log(socket.setMulticastTTL(2), socket.setMulticastLoopback(true));
  console.log(socket.setMulticastInterface("127.0.0.1"));
}

/** A membership joined and dropped on a socket that arrives as `unknown`. */
function membership(value: unknown): void {
  const socket = value as any;
  console.log(socket.addMembership("224.0.0.114", "127.0.0.1"));
  console.log(socket.dropMembership("224.0.0.114", "127.0.0.1"));
}

/** disconnect() on a connected socket. */
function disconnect(socket: any): void {
  console.log(socket.disconnect());
}

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.on("close", () => resolve());
  socket.bind(0, "127.0.0.1", () => {
    tune(socket);
    socket.close();
  });
});

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("close", () => resolve());
  socket.bind(0, "0.0.0.0", () => {
    membership(socket);
    socket.close();
  });
});

await new Promise<void>((resolve) => {
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

// An unbound socket raises the option's system error through `any` too.
{
  const socket = dgram.createSocket("udp4");
  const untyped: any = socket;
  try {
    untyped.setBroadcast(true);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    console.log(failure.code, failure.syscall);
  }
  socket.close();
}

// A value that is not a socket has no such member.
try {
  tune({});
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
