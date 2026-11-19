// A paused socket whose write half has finished keeps the peer's response:
// the bytes are buffered (not read and discarded while nothing listens),
// and resume() delivers them, ending the read half afterwards.
import * as net from "node:net";

const server = net.createServer((sock) => {
  sock.on("end", () => {
    console.log("server end");
    sock.end("response");
    console.log("server sent");
  });
  sock.on("close", () => {
    console.log("server socket close");
    server.close();
  });
  sock.resume();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

await new Promise<void>((resolve) => {
  server.on("close", () => resolve());
  const client = net.connect(port, "127.0.0.1", () => {
    console.log("client connect");
    client.pause();
    client.end();
    console.log("client ended");
    setTimeout(() => {
      console.log("client resume, readableLength", client.readableLength);
      client.resume();
    }, 250);
  });
  client.on("data", (chunk) => console.log("client data", chunk.toString()));
  client.on("end", () => console.log("client end"));
});
