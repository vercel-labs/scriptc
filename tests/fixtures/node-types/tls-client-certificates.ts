// Under @types/node: a mutual-TLS server that requires a client
// certificate signed by its CA, and a client that presents one.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);

const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
let serverLine = "";
const server = tls.createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: true }, (socket: tls.TLSSocket) => {
  const peer: tls.PeerCertificate = socket.getPeerCertificate();
  serverLine = `server ${socket.authorized} ${String(socket.authorizationError)} ${peer.subject.CN}`;
  socket.end("welcome");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const clientCert = readFileSync(`${certs}/client.pem`);
  const clientKey = readFileSync(`${certs}/client-key.pem`);
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca, cert: clientCert, key: clientKey }, () => {
    console.log("client", client.authorized, client.getX509Certificate()?.subject);
  });
  let body = "";
  client.on("data", (chunk: Buffer) => (body += chunk.toString()));
  client.on("end", () => {
    console.log(serverLine);
    console.log("body", body);
    server.close();
  });
});
