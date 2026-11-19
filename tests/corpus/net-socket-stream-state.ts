// A socket's Readable/Writable stream state — the Duplex getters Node puts
// on every socket: aborted/didRead/ended/flowing/length, the write half's
// ended/finished, the high-water marks, allowHalfOpen, and the owning
// server. Printed across a connection's lifecycle in both lanes.
import * as net from "node:net";

const state = (label: string, s: net.Socket): void => {
  // Node 24's socket answers undefined for writableAborted (its Duplex
  // prototype chain skips Writable's getter); the untyped read carries it.
  console.log(
    label,
    "ah=" + s.allowHalfOpen,
    "rA=" + s.readableAborted,
    "rD=" + s.readableDidRead,
    "rE=" + s.readableEnded,
    "rF=" + String(s.readableFlowing),
    "rL=" + s.readableLength,
    "rH=" + s.readableHighWaterMark,
    "wE=" + s.writableEnded,
    "wF=" + s.writableFinished,
    "wA=" + String((s as any).writableAborted),
    "wH=" + s.writableHighWaterMark,
    "srv=" + (s.server !== null),
  );
};

// a bare socket and the allowHalfOpen option
const bare = new net.Socket();
state("bare", bare);
const halfOpen = new net.Socket({ allowHalfOpen: true });
state("bare-half-open", halfOpen);
// a 'readable' listener puts the stream in paused mode (flowing false)
const readableMode = new net.Socket();
readableMode.on("readable", () => {});
state("readable-mode", readableMode);
bare.destroy();
halfOpen.destroy();
readableMode.destroy();

const server = net.createServer((sock) => {
  state("server-conn", sock);
  sock.on("end", () => {
    state("server-end", sock);
  });
  sock.on("close", () => {
    state("server-close", sock);
  });
  sock.on("data", (chunk) => {
    console.log("server-chunk", chunk.toString());
    state("server-data", sock);
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

await new Promise<void>((resolve) => {
  const client = net.connect(port, "127.0.0.1", () => {
    state("client-connect", client);
    client.pause();
    state("client-paused", client);
    client.resume();
    state("client-resumed", client);
    client.write("hello");
    client.end();
  });
  client.on("end", () => state("client-end", client));
  client.on("close", () => {
    state("client-close", client);
    server.close();
    resolve();
  });
});

// destroy() before the peer's FIN: the read half is aborted, not ended
const server2 = net.createServer((sock) => {
  state("abort-conn", sock);
  sock.on("close", () => state("abort-server-close", sock));
});
await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
const port2 = (server2.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => {
  const other = net.connect(port2, "127.0.0.1", () => {
    other.destroy();
    setTimeout(() => {
      state("client-destroyed", other);
      console.log("writableAborted", String((other as any).writableAborted));
      server2.close();
      resolve();
    }, 20);
  });
  other.on("error", () => {});
});
