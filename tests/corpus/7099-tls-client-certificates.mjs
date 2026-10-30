// Client certificates from JavaScript match Node: a server that requests
// one reads socket.authorized, authorizationError and the peer
// certificate's chain, and a client sends its cert and key.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const D = "tests/fixtures/server/certs";
const ca = readFileSync(`${D}/ca.pem`);
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const clientCert = readFileSync(`${D}/client.pem`);
const clientKey = readFileSync(`${D}/client-key.pem`);

const lines = [];
const server = tls.createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: false }, (socket) => {
  const peer = socket.getPeerCertificate(true);
  lines.push(`server ${socket.authorized} ${socket.authorizationError} ${peer.subject?.CN} ${peer.issuerCertificate?.subject.CN} ${peer.ext_key_usage}`);
  socket.end("hello");
});
server.listen(0, () => {
  const port = server.address().port;
  const first = tls.connect({ port, ca, servername: "localhost", cert: clientCert, key: clientKey }, () => {
    lines.push(`client ${first.authorized} ${first.getCertificate().subject.CN} ${first.getX509Certificate()?.subject}`);
  });
  first.resume();
  first.on("end", () => {
    const second = tls.connect({ port, ca, servername: "localhost" }, () => lines.push(`anonymous ${second.authorized}`));
    second.resume();
    second.on("end", () => {
      for (const line of lines) console.log(line);
      server.close();
    });
  });
});
