// pause() called from inside a TLS socket's 'data' handler stops the
// transport before the next record: the ciphertext arriving while the
// socket is paused waits in the kernel, and resume() delivers it (nothing
// is read and discarded in between).
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const server = tls.createServer({ key, cert }, (socket) => {
  let seen = 0;
  socket.on("data", (chunk) => {
    seen += 1;
    console.log("server data", seen, chunk.toString());
    if (seen === 1) {
      socket.pause();
      console.log("paused", String(socket.readableFlowing));
      // the peer sends its second record only after this answer, so it
      // arrives while the socket is paused
      socket.write("ack");
      setTimeout(() => {
        console.log("resume", String(socket.readableFlowing));
        socket.resume();
      }, 200);
    } else {
      socket.end("done");
    }
  });
  socket.on("end", () => console.log("server end"));
  socket.on("close", () => {
    console.log("server close");
    server.close();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  server.on("close", () => resolve());
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    console.log("client secure");
    client.write("one");
  });
  client.on("data", (chunk) => {
    const text = chunk.toString();
    console.log("client data", text);
    if (text === "ack") client.write("two");
    if (text === "done") client.end();
  });
  client.on("end", () => console.log("client end"));
});
