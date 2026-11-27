// tlsSocket.servername on both sides of a handshake, getSession's Buffer,
// disableRenegotiation on an established socket, and a client that offers no
// SNI.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const serverNames: string[] = [];
const server = tls.createServer({ key, cert }, (socket) => {
  serverNames.push(String(socket.servername));
  socket.on("data", () => {});
  socket.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    console.log("client servername", client.servername);
    const session = client.getSession();
    console.log("session", session === null ? "null" : Buffer.isBuffer(session), (session?.length ?? 0) > 0);
    client.disableRenegotiation();
    console.log("renegotiation disabled");
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
});

await new Promise<void>((resolve) => {
  const bare = tls.connect(
    { port, host: "127.0.0.1", servername: "", rejectUnauthorized: false },
    () => console.log("bare servername", bare.servername),
  );
  bare.on("data", () => {});
  bare.on("error", () => {});
  bare.on("close", () => resolve());
});

await new Promise<void>((resolve) => setTimeout(resolve, 10));
console.log("server servernames", serverNames.join(","));
server.close();
