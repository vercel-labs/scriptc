// tls.Server's addContext, setSecureContext and 'tlsClientError' from
// JavaScript match Node: a wildcard SNI context, the default context
// replaced, and the errors a plain-text client and one that leaves
// before its hello report.
import * as net from "node:net";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const alt = readFileSync(`${D}/alt.pem`);
const altKey = readFileSync(`${D}/alt-key.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end());
server.addContext("*.localhost", { cert: alt, key: altKey });
server.on("tlsClientError", (err, socket) => {
  const reason = err.message.replace(/^[0-9A-F]+:/, "").split(":../")[0];
  console.log("tlsClientError", err.code, reason, socket.destroyed);
});

function peer(port, servername) {
  return new Promise((resolve) => {
    const c = tls.connect({ port, servername, rejectUnauthorized: false }, () => {
      resolve(c.getPeerCertificate().subject.CN);
      c.end();
    });
  });
}

function raw(port, bytes) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      if (bytes) s.write(bytes);
      else s.end();
    });
    s.on("data", () => {});
    s.on("error", (err) => console.log("client error", err.code));
    s.on("close", () => setTimeout(resolve, 50));
  });
}

server.listen(0, async () => {
  const { port } = server.address();
  console.log("sni", await peer(port, "alt.localhost"), await peer(port, "localhost"));
  server.setSecureContext({ cert: alt, key: altKey });
  console.log("after setSecureContext", await peer(port, "example.test"));
  await raw(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await raw(port, null);
  server.close();
});
