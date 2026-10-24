// Client certificates match Node: tls.createServer's requestCert,
// rejectUnauthorized and ca against clients that send no certificate, a
// valid one, one without the clientAuth purpose and a self-signed one
// (socket.authorized and authorizationError on the server, the peer
// certificate, the client's own certificate), the client's chain completed
// from its ca, and a server that requires a certificate rejecting a client
// without one in TLS 1.3 and TLS 1.2 (the client's events and codes).
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), ca2 = r("ca2.pem"), cert = r("localhost.pem"), key = r("localhost-key.pem");
const client = r("client.pem"), clientKey = r("client-key.pem");
const self = r("selfsigned.pem"), selfKey = r("selfsigned-key.pem");

type Handler = (s: tls.TLSSocket) => void;
const servers: [string, (h: Handler) => tls.Server][] = [
  ["request", (h) => tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca }, h)],
  ["reject", (h) => tls.createServer({ cert, key, requestCert: true, ca }, h)],
  ["request-noca", (h) => tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false }, h)],
  ["request-ca2", (h) => tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca: ca2 }, h)],
  // an empty Buffer is an empty trust store; an empty string is no ca
  ["request-empty", (h) => tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca: Buffer.alloc(0) }, h)],
  ["request-emptystr", (h) => tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca: "" }, h)],
  ["plain", (h) => tls.createServer({ cert, key }, h)],
];
const clients: [string, Buffer | null, Buffer | null][] = [
  ["none", null, null],
  ["valid", client, clientKey],
  ["serverEku", cert, key],
  ["self", self, selfKey],
];
async function run(label: string, make: (h: Handler) => tls.Server, name: string, clientCert: Buffer | null, clientKeyPem: Buffer | null): Promise<void> {
  await new Promise<void>((done) => {
    const events: string[] = [];
    const server = make((s) => {
      events.push(`server secureConnection authorized=${s.authorized} error=${s.authorizationError} peer=${(s.getPeerCertificate() as tls.PeerCertificate).subject?.CN} x509=${s.getPeerX509Certificate()?.subject}`);
      s.end("ok");
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const c =
        clientCert === null || clientKeyPem === null
          ? tls.connect({ port, ca, servername: "localhost" })
          : tls.connect({ port, ca, servername: "localhost", cert: clientCert, key: clientKeyPem });
      c.on("secureConnect", () => events.push(`client secureConnect own=${(c.getCertificate() as tls.PeerCertificate | null)?.subject?.CN}`));
      c.on("data", (d: Buffer) => events.push(`client data ${d}`));
      c.on("end", () => events.push("client end"));
      c.on("error", (e: NodeJS.ErrnoException) => events.push(`client error ${e.code}`));
      c.on("close", () => {
        setTimeout(() => {
          console.log(label, name, "|", events.join(" ; "));
          server.close(() => done());
        }, 50);
      });
    });
  });
}
for (const [label, make] of servers) {
  for (const [name, c, k] of clients) await run(label, make, name, c, k);
}

// A server that requires a certificate, per protocol version: TLS 1.3
// rejects after the client's handshake, TLS 1.2 during it.
for (const maxVersion of ["TLSv1.3", "TLSv1.2"] as const) {
  await new Promise<void>((done) => {
    const server = tls.createServer({ cert, key, requestCert: true, ca, maxVersion }, (s) => s.end("ok"));
    server.listen(0, () => {
      const events: string[] = [];
      const c = tls.connect({ port: (server.address() as AddressInfo).port, ca, servername: "localhost" });
      c.on("secureConnect", () => events.push("secureConnect"));
      c.on("data", () => events.push("data"));
      c.on("end", () => events.push("end"));
      c.on("error", (e: NodeJS.ErrnoException) => events.push(`error ${e.code}`));
      c.on("close", (hadError: boolean) => {
        events.push(`close ${hadError}`);
        console.log(maxVersion, events.join(" ; "));
        server.close(() => done());
      });
    });
  });
}
