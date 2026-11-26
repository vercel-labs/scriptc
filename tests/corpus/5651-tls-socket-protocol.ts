// A TLS socket's negotiated protocol, cipher and ALPN result: getProtocol
// answers the highest version on offer before the handshake, the
// negotiated one after it and null after close,
// getCipher names the suite three ways, alpnProtocol is false without
// ALPN, and the module's default protocol range is TLSv1.2 to TLSv1.3
// with the provider choosing the ECDH curve ("auto").
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

console.log("defaults", tls.DEFAULT_MIN_VERSION, tls.DEFAULT_MAX_VERSION, tls.DEFAULT_ECDH_CURVE);

// The server's secureConnection and the client's secureConnect race, so
// each side records its lines and both print once both have run.
let serverLine: string | null = null;
let clientLines: string | null = null;
function bothSecure(): void {
  if (serverLine === null || clientLines === null) return;
  console.log(serverLine);
  console.log(clientLines);
}

const server = tls.createServer({ key, cert }, (socket) => {
  const cipher = socket.getCipher();
  serverLine =
    `server ${socket.getProtocol()} ${cipher.version} ${cipher.name === cipher.standardName} ` +
    `${socket.alpnProtocol}`;
  bothSecure();
  socket.end("hi");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    const cipher = client.getCipher();
    clientLines =
      `client ${client.getProtocol()} ${client.authorized} ${client.alpnProtocol}\n` +
      `cipher ${typeof cipher.name} ${cipher.standardName.startsWith("TLS_")} ${cipher.version}`;
    bothSecure();
  });
  console.log("before handshake", client.alpnProtocol, client.getProtocol());
  client.on("data", (d: Buffer) => console.log("data", d.toString()));
  client.on("close", () => {
    console.log("after close", client.getProtocol());
    server.close();
  });
});
