// A paused established TLS socket keeps the peer's plaintext: the engine
// decrypts on demand, so nothing is read (or dropped) while the socket is
// paused — the ciphertext waits in the kernel and resume() delivers the
// decrypted bytes.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const server = tls.createServer({ key, cert }, (socket) => {
  socket.pause();
  console.log("paused", String(socket.readableFlowing));
  socket.on("data", (chunk) => {
    console.log("server data", chunk.toString());
    socket.end("done");
  });
  socket.on("end", () => console.log("server end"));
  socket.on("close", () => {
    console.log("server close");
    server.close();
  });
  // resume once the client's bytes are already waiting in the kernel
  setTimeout(() => {
    console.log("resume", String(socket.readableFlowing));
    socket.resume();
  }, 150);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  server.on("close", () => resolve());
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    console.log("client secure");
    client.write("hello");
  });
  client.on("data", (chunk) => {
    console.log("client data", chunk.toString());
    client.end();
  });
  client.on("end", () => console.log("client end"));
});
