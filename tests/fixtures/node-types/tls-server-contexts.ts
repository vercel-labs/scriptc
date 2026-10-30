// Under @types/node: a tls.Server that answers an SNI name from
// addContext, replaces its default context with setSecureContext, and
// reports a plain-text client through 'tlsClientError'.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const alt = readFileSync(`${certs}/alt.pem`);
const altKey = readFileSync(`${certs}/alt-key.pem`);

const server: tls.Server = tls.createServer({ cert, key }, (socket: tls.TLSSocket) => socket.end());
server.addContext("*.localhost", tls.createSecureContext({ cert: alt, key: altKey }));
server.on("tlsClientError", (err: Error, socket: tls.TLSSocket) => {
  console.log("tlsClientError", (err as NodeJS.ErrnoException).code, socket.destroyed);
});

function subject(port: number, servername: string): Promise<string> {
  return new Promise((resolve) => {
    const client = tls.connect({ port, host: "127.0.0.1", servername, rejectUnauthorized: false }, () => {
      resolve(String(client.getPeerCertificate().subject.CN));
      client.end();
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as AddressInfo).port;
  console.log("sni", await subject(port, "alt.localhost"), await subject(port, "localhost"));
  server.setSecureContext({ cert: alt, key: altKey });
  console.log("default", await subject(port, "localhost"));
  const raw = net.connect(port, "127.0.0.1", () => raw.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
  raw.on("data", () => {});
  raw.on("close", () => setTimeout(() => server.close(), 50));
});
