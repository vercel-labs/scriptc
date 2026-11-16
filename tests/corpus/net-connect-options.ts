// net.connect(options[, listener]) and net.createConnection(options[,
// listener]): the options record (port, host, family, localAddress and
// localPort) with the connect listener, and the address fields after the
// connection.
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    console.log("server got", String(chunk));
    socket.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

const options = { port, host: "127.0.0.1", family: 4 as const };
await new Promise<void>((resolve) => {
  const client = net.connect(options, () => {
    console.log("connect options", client.connecting, client.readyState);
    console.log("remote", client.remoteAddress, client.remotePort === port, client.remoteFamily);
    console.log("local", client.localAddress, client.localFamily, typeof client.localPort === "number" && client.localPort > 0);
    client.write("one");
  });
  client.on("data", (chunk) => console.log("client got", String(chunk)));
  client.on("close", () => resolve());
});

await new Promise<void>((resolve) => {
  const client = net.createConnection(
    { port, host: "127.0.0.1", localAddress: "127.0.0.1" },
    () => {
      console.log("createConnection options", client.localAddress);
      client.write("two");
    },
  );
  client.on("data", (chunk) => console.log("client got", String(chunk)));
  client.on("close", () => resolve());
});

server.close();
