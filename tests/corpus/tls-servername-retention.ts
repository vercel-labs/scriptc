// tlsSocket.servername answers a fresh string per read on both sides of a
// handshake: repeated reads of a server socket's peer SNI name and of the
// client's offered name, over several connections (the sanitized lane sees
// any reference the accessor fails to release).
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const serverNames: string[] = [];
const clientNames: string[] = [];

const server = tls.createServer({ key, cert }, (socket) => {
  const names = [socket.servername, socket.servername, socket.servername];
  serverNames.push(`${names.every((name) => name === "localhost")}:${names.length}`);
  socket.on("data", () => {});
  socket.end("ok");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

for (let round = 0; round < 3; round++) {
  await new Promise<void>((resolve) => {
    const client = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
      const names = [client.servername, client.servername, client.servername];
      clientNames.push(`${names.every((name) => name === "localhost")}:${names.length}`);
    });
    client.on("data", () => {});
    client.on("close", () => resolve());
    client.on("error", (err: Error) => {
      clientNames.push(`error:${(err as NodeJS.ErrnoException).code}`);
      resolve();
    });
  });
}

console.log("client", clientNames.join(","));
console.log("server", serverNames.join(","));
server.close();
