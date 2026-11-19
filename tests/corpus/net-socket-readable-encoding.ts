// socket.readableEncoding names the encoding setEncoding installed (null
// while 'data' delivers Buffers), canonicalized as Node's StringDecoder
// does, and a socket's streams are byte streams.
import * as net from "node:net";

const server = net.createServer((sock) => {
  sock.resume();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

await new Promise<void>((resolve) => {
  const client = net.connect(port, "127.0.0.1", () => {
    console.log(
      "before",
      String(client.readableEncoding),
      client.readableObjectMode,
      client.writableObjectMode,
    );
    client.setEncoding("UTF-8");
    console.log("utf8", client.readableEncoding);
    client.setEncoding("hex");
    console.log("hex", client.readableEncoding);
    client.setEncoding(undefined);
    console.log("undefined", client.readableEncoding);
    client.setEncoding("latin1");
    // an untyped null encoding is StringDecoder's utf8 default, not an error
    (client as any).setEncoding(null);
    console.log("null", client.readableEncoding);
    try {
      client.setEncoding("bogus" as BufferEncoding);
    } catch (err) {
      console.log("bogus", (err as NodeJS.ErrnoException).code, (err as Error).message);
    }
    console.log("after bogus", client.readableEncoding);
    client.destroy();
    server.close();
    resolve();
  });
  client.on("error", (err: Error) => {
    console.log("error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});
