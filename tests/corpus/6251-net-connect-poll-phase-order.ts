// A connection started by a poll-phase callback completes in the NEXT loop
// iteration's poll phase: the callback's nextTick and promise jobs run
// first, then the check phase's setImmediate, then the new socket's
// 'connect' (libuv/Node order; loopback connects complete at once, so an
// event loop that polls again before the check phase reorders them). The
// second half is the same through an awaited promise, the shape of an HTTP
// client that dials a fresh connection after the previous response.
import * as net from "node:net";

const log: string[] = [];
const server = net.createServer((socket) => {
  socket.on("data", (chunk: Buffer) => socket.write(chunk));
});

function dial(port: number, label: string): Promise<net.Socket> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      log.push(`connect ${label}`);
      resolve(socket);
    });
  });
}

function roundTrip(socket: net.Socket, label: string): Promise<void> {
  return new Promise((resolve) => {
    socket.once("data", () => {
      log.push(`data ${label}`);
      setImmediate(() => log.push(`immediate after data ${label}`));
      process.nextTick(() => log.push(`tick after data ${label}`));
      Promise.resolve().then(() => log.push(`promise after data ${label}`));
      resolve();
    });
    socket.write("ping");
  });
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  const first = net.connect({ port, host: "127.0.0.1" });
  first.on("connect", () => {
    log.push("connect first");
    first.write("ping");
  });
  first.once("data", () => {
    log.push("data first");
    setImmediate(() => log.push("immediate from data"));
    process.nextTick(() => log.push("tick from data"));
    Promise.resolve().then(() => log.push("promise from data"));
    const second = net.connect({ port, host: "127.0.0.1" });
    second.on("connect", async () => {
      log.push("connect second");
      second.destroy();
      first.destroy();
      // Awaited: each response's continuation dials the next connection.
      const a = await dial(port, "a");
      await roundTrip(a, "a");
      log.push("continuation after a");
      const b = await dial(port, "b");
      await roundTrip(b, "b");
      a.destroy();
      b.destroy();
      setImmediate(() => {
        server.close();
        console.log(log.join("\n"));
      });
    });
  });
});
