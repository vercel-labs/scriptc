// net.Server's teardown and admission control: BlockList.PRIVATE_RANGES,
// server[Symbol.asyncDispose]() and `await using` (Node's
// promisify(this.close)), the 'drop' event for a connection past
// maxConnections with its address payload, and dropMaxConnection, which
// net.js never reads (only cluster mode does) and so stores as written.
import * as net from "node:net";

const ranges = net.BlockList.PRIVATE_RANGES;
console.log("private ranges", ranges.length, ranges[0], ranges[ranges.length - 1]);

// Explicit disposal: the promise settles once the server closed.
{
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  console.log("dispose listening", server.listening);
  await server[Symbol.asyncDispose]();
  console.log("disposed", server.listening);
}

// A server that never listened disposes at once.
{
  const idle = net.createServer();
  await idle[Symbol.asyncDispose]();
  console.log("idle disposed", idle.listening);
}

// `await using` closes at the block's end.
{
  await using server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  console.log("using listening", server.listening);
}
console.log("using closed");

// A connection past maxConnections is dropped with its address payload.
const held: net.Socket[] = [];
const server = net.createServer((socket) => {
  socket.on("error", () => {});
  held.push(socket);
});
server.maxConnections = 1;
server.on("drop", (data?: net.DropArgument) => {
  console.log(
    "drop",
    data !== undefined,
    data?.localAddress === "127.0.0.1",
    data?.remoteAddress === "127.0.0.1",
    data?.localFamily,
    data?.remoteFamily,
    typeof data?.localPort,
    typeof data?.remotePort,
  );
});
const raw: any = server;
console.log("dropMaxConnection unset", raw.dropMaxConnection);
raw.dropMaxConnection = false;
console.log("dropMaxConnection", raw.dropMaxConnection);
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const first = net.connect(port, "127.0.0.1");
  first.on("error", () => {});
  first.on("connect", () => {
    setTimeout(() => {
      const second = net.connect(port, "127.0.0.1");
      second.on("error", () => {});
      second.on("close", () => {
        console.log("second closed");
        for (const socket of held) socket.destroy();
        server.close(() => console.log("server closed"));
      });
    }, 20);
  });
});
