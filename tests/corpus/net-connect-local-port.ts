// socket.connect({ port, localPort }) without a localAddress binds the
// wildcard: Node binds INADDR_ANY on that port.
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

// A deterministic local port: reserve one, then use it after release.
const reserve = net.createServer();
await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const localPort = (reserve.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));

await new Promise<void>((resolve) => {
  const client = new net.Socket();
  client.connect({ port, localPort }, () => {
    console.log("connected", client.localPort === localPort, client.localAddress);
    client.on("close", () => resolve());
    client.destroy();
  });
  client.on("error", (e) => {
    console.log("error", (e as NodeJS.ErrnoException).code);
    resolve();
  });
});

server.close();
