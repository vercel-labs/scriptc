// tls.connect(path[, options][, callback]) and connect({ path }): a TLS
// client over a Unix domain socket.
import * as tls from "node:tls";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

// A fixed name in the shared temp directory collides with the other suite
// running this program at the same time (its Node oracle against this
// binary): one run removes or listens on the other's socket, and the oracle
// itself exits non-zero. Name the socket after the process.
const socketPath = join(tmpdir(), `scriptc-tls-unix-connect-${process.pid}.sock`);
rmSync(socketPath, { force: true });

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.end();
});
await new Promise<void>((resolve) => server.listen(socketPath, resolve));

await new Promise<void>((resolve) => {
  const client = tls.connect(socketPath, { servername: "localhost", ca }, () => {
    console.log("path listener", client.authorized, client.getProtocol());
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
});

await new Promise<void>((resolve) => {
  const client = tls.connect({ path: socketPath, servername: "localhost", ca }, () => {
    console.log("options path listener", client.authorized);
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
});

server.close(() => {
  console.log("closed");
  rmSync(socketPath, { force: true });
});
