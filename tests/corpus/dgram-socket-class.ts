// dgram.Socket as a class and createSocket's forms: instanceof, the type
// property, the message-listener argument, the options record
// (reuseAddr, recvBufferSize, sendBufferSize), udp6, and the
// constructor's argument errors.
import * as dgram from "node:dgram";

function attempt(label: string, op: () => unknown): void {
  try {
    const value = op();
    console.log(label, typeof value);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const v4 = dgram.createSocket("udp4");
console.log("udp4", v4 instanceof dgram.Socket, v4.type);
v4.close();
const v6 = dgram.createSocket("udp6");
console.log("udp6", v6 instanceof dgram.Socket, v6.type);
v6.close();

// createSocket(type, listener): the listener subscribes to 'message'.
await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp4", (msg, rinfo) => {
    console.log("listener", String(msg), rinfo.family, rinfo.size);
    socket.close();
  });
  socket.on("close", () => resolve());
  socket.bind(0, "127.0.0.1", () => socket.send("ping", socket.address().port, "127.0.0.1"));
});

// createSocket(options) — an options record read at run time (a local
// record, not an inline literal).
const options = {
  type: "udp4" as const,
  reuseAddr: true,
  recvBufferSize: 8192,
  sendBufferSize: 8192,
};
await new Promise<void>((resolve) => {
  const socket = dgram.createSocket(options);
  socket.on("close", () => resolve());
  socket.bind(0, "127.0.0.1", () => {
    console.log(
      "options",
      socket.type,
      socket.getRecvBufferSize() >= 8192,
      socket.getSendBufferSize() >= 8192,
    );
    socket.close();
  });
});

attempt("bad type", () => dgram.createSocket("udp9" as "udp4"));
attempt("missing type", () => dgram.createSocket({} as { type: "udp4" }));
attempt("fractional recv size", () =>
  dgram.createSocket({ type: "udp4", recvBufferSize: 1.5 }),
);
attempt("negative send size", () => dgram.createSocket({ type: "udp4", sendBufferSize: -1 }));

// instanceof on a value held untyped: the socket handle's tag.
const untyped: unknown = dgram.createSocket("udp4");
console.log("untyped", untyped instanceof dgram.Socket);
(untyped as dgram.Socket).close();
console.log("plain object", ({}) instanceof dgram.Socket);
