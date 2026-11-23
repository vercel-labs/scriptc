// setMaxSendFragment() while a write is backpressured: the record the
// engine is still writing keeps its own length, so lowering the cap mid-
// write re-shapes later records without moving a byte. A 32 MiB write the
// peer pauses on arrives complete and in order; the pattern check proves
// no byte was dropped or repeated.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

const SIZE = 32 * 1024 * 1024;
let received = 0;
let bad = 0;
const guard = setTimeout(() => {
  console.log("stalled", received, bad);
  process.exit(1);
}, 20000);
const server = tls.createServer({ key, cert }, (sock) => {
  sock.pause();
  sock.on("data", (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) if (chunk[i] !== (received + i) % 251) bad++;
    received += chunk.length;
  });
  sock.on("end", () => {
    console.log("received", received, bad);
    server.close(() => {
      clearTimeout(guard);
      console.log("closed");
    });
  });
  setTimeout(() => sock.resume(), 1000);
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  client.on("error", (err: Error) => console.log("error", err.message));
  client.on("secureConnect", () => {
    client.setMaxSendFragment(1024);
    const payload = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) payload[i] = i % 251;
    console.log("write accepted", client.write(payload));
    setTimeout(() => console.log("recap", client.setMaxSendFragment(512)), 500);
    client.end();
  });
  client.on("data", () => {});
});
