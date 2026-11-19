// The net.Socket member audit: the chaining answers of ref/unref, pause,
// resume and setEncoding, the timeout property before and after
// setTimeout, the 'timeout' event, and address() across the socket's
// states.
import * as net from "node:net";

function attempt(label: string, op: () => unknown): void {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    console.log("server got", String(chunk));
    socket.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

const socket = new net.Socket();
console.log("timeout unset", socket.timeout);
attempt("setEncoding unknown", () => socket.setEncoding("nope"));
console.log(
  "chains",
  socket.ref() === socket,
  socket.unref() === socket,
  socket.pause() === socket,
  socket.resume() === socket,
  socket.setEncoding("utf8") === socket,
  socket.setTimeout(50) === socket,
);
console.log("timeout set", socket.timeout);
console.log("setTimeout zero chained", socket.setTimeout(0) === socket);
console.log("timeout zero", socket.timeout);
console.log("connecting address", JSON.stringify(socket.address()));
socket.destroy();

// The idle 'timeout' event does not sever the connection.
await new Promise<void>((resolve) => {
  const idle = new net.Socket();
  idle.setTimeout(10, () => console.log("timeout event", idle.timeout));
  idle.on("connect", () => {
    const started = Date.now();
    const check = setInterval(() => {
      if (Date.now() - started < 120) return;
      clearInterval(check);
      idle.destroy();
    }, 5);
  });
  idle.on("close", () => resolve());
  idle.connect(port, "127.0.0.1", () => {});
  idle.on("data", () => {});
});

server.close();
