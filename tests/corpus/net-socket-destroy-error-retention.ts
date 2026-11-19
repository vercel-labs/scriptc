// destroy(error) retains the Error its 'error' event delivers: the Error
// is a temporary the statement cleanup releases before the event sweep
// reads it.
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

function destroyWithFreshError(socket: net.Socket): void {
  socket.destroy(new Error("fresh error payload"));
}

await new Promise<void>((resolve) => {
  const client = new net.Socket();
  client.on("error", (e) => console.log("error", (e as Error).message));
  client.on("close", (hadError) => {
    console.log("close", hadError);
    resolve();
  });
  client.connect(port, "127.0.0.1", () => destroyWithFreshError(client));
});

server.close();
