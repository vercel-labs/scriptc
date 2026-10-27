// Under @types/node: a connector-style TLS client reads
// isSessionReused() through a TLSSocket assertion and keeps per-phase
// timings in a string-keyed record with `??=`.
import * as net from "node:net";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const timings: Record<string, number> = {};
function mark(phase: string, value: number): void {
  timings[phase] ??= value;
}

const server = tls.createServer({ key, cert }, (socket) => socket.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const socket: net.Socket = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    mark("secure", 1);
    mark("secure", 2);
    console.log("reused", (socket as tls.TLSSocket).isSessionReused());
  });
  socket.on("data", (d: Buffer) => console.log("data", d.toString()));
  socket.on("close", () => {
    mark("close", 3);
    console.log(JSON.stringify(timings));
    server.close();
  });
});
