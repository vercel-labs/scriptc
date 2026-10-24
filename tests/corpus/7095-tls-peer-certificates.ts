// tlsSocket.getPeerCertificate([detailed]), getCertificate(),
// getPeerX509Certificate() and getX509Certificate() match Node: the
// legacy certificate objects, {} before a handshake or without a
// certificate and null once the socket is destroyed; the detailed
// issuerCertificate chain from the certificates the peer sent and then
// the trust anchors, in any order, ending at a self-issued root that is its
// own issuer; and the certificates served by SNI answers, secureContext
// wraps and https servers.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const d = "tests/fixtures/server/certs";
const read = (f: string): Buffer => readFileSync(`${d}/${f}`);
const ca = read("ca.pem"), ca2 = read("ca2.pem"), cert = read("localhost.pem"), key = read("localhost-key.pem");
const self = read("selfsigned.pem"), selfKey = read("selfsigned-key.pem"), alt = read("alt.pem"), altKey = read("alt-key.pem");

function describe(label: string, o: tls.PeerCertificate | tls.DetailedPeerCertificate | object | null): string {
  if (o === null) return `${label} null`;
  const keys = Object.keys(o);
  if (keys.length === 0) return `${label} {}`;
  const p = o as tls.DetailedPeerCertificate;
  const issuer = p.issuerCertificate;
  const link = issuer ? ` issuerCert:${issuer.subject.CN} self:${issuer === issuer.issuerCertificate} same:${issuer === p}` : "";
  return `${label} ${keys.join(",")} ${p.subject.CN} ${p.issuer.CN}${link}`;
}
function show(label: string, o: tls.PeerCertificate | tls.DetailedPeerCertificate | object | null): void {
  console.log(describe(label, o));
}
// A server's lines print once its client has the reply, so the output
// order does not depend on which side's callback runs first.
const serverLines: string[] = [];
function flushServer(): void {
  for (const line of serverLines.splice(0)) console.log(line);
}
await new Promise<void>((done) => {
const server = tls.createServer({ cert, key }, (s) => {
  serverLines.push(describe("server peer", s.getPeerCertificate()));
  serverLines.push(describe("server peer detailed", s.getPeerCertificate(true)));
  serverLines.push(`server peerX509 ${s.getPeerX509Certificate()?.subject}`);
  serverLines.push(describe("server own", s.getCertificate()));
  serverLines.push(`server ownX509 ${s.getX509Certificate()?.subject}`);
  s.end("hi");
});
server.listen(0, () => {
  const c = tls.connect({ port: (server.address() as AddressInfo).port, ca, servername: "localhost" }, () => {
    show("client peer", c.getPeerCertificate());
    const det = c.getPeerCertificate(true);
    show("client peer detailed", det);
    show("client issuer", det.issuerCertificate);
    const x = c.getPeerX509Certificate();
    if (x) console.log("client peerX509", x.subject, x.issuer, x === c.getPeerX509Certificate(), x.checkIssued(new X509Certificate(ca)), x.checkHost("localhost"));
    show("client own", c.getCertificate());
    console.log("client ownX509", c.getX509Certificate()?.subject);
    console.log("peer raw eq", c.getPeerCertificate().raw.equals(x!.raw), c.getPeerCertificate() === c.getPeerCertificate());
  });
  c.on("data", () => {});
  c.on("end", () => {
    flushServer();
    show("after end peer", c.getPeerCertificate());
    c.destroy();
  });
  c.on("close", () => {
    show("after close peer", c.getPeerCertificate());
    console.log("after close X509", c.getPeerX509Certificate()?.subject, c.getCertificate());
    server.close(() => done());
  });
  show("before handshake", c.getPeerCertificate());
  console.log("before X509", c.getPeerX509Certificate()?.subject, c.getCertificate(), c.getX509Certificate()?.subject);
});
});

function chain(o: tls.DetailedPeerCertificate | null): string {
  if (o === null) return "null";
  if (Object.keys(o).length === 0) return "{}";
  const names: string[] = [];
  let at: tls.DetailedPeerCertificate | undefined = o;
  for (let i = 0; at !== undefined && i < 6; i++) {
    names.push(at.subject.CN as string);
    const next: tls.DetailedPeerCertificate | undefined = at.issuerCertificate;
    if (next === at) {
      names.push("(self)");
      break;
    }
    at = next;
  }
  return names.join(" -> ");
}
async function run(label: string, served: Buffer, servedKey: Buffer, trust: Buffer | null): Promise<void> {
  await new Promise<void>((done) => {
    const server = tls.createServer({ cert: served, key: servedKey }, (s) => s.end());
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const socket =
        trust === null
          ? tls.connect({ port, servername: "localhost", rejectUnauthorized: false })
          : tls.connect({ port, servername: "localhost", ca: trust, rejectUnauthorized: false });
      socket.on("secureConnect", () => {
        console.log(label, socket.authorized, chain(socket.getPeerCertificate(true)));
        console.log(label, "abbreviated", "issuerCertificate" in socket.getPeerCertificate(), "issuerCertificate" in socket.getPeerCertificate(false));
        socket.destroy();
        console.log(label, "destroyed", socket.getPeerCertificate(), socket.getPeerX509Certificate()?.subject, socket.getCertificate());
        server.close(() => done());
      });
      socket.on("error", (e) => console.log(label, "error", e.message));
    });
  });
}
await run("leaf", cert, key, ca);
await run("sent chain", Buffer.concat([cert, ca]), key, ca);
await run("sent chain, default store", Buffer.concat([cert, ca]), key, null);
await run("out of order", Buffer.concat([cert, ca2, ca]), key, ca);
await run("self-signed", self, selfKey, null);
await run("wrong ca", cert, key, ca2);
await run("leaf, default store", cert, key, null);

// SNI and secureContext: the certificate the server socket serves.
await new Promise<void>((done) => {
  const altCtx = tls.createSecureContext({ cert: alt, key: altKey });
  const server = tls.createServer({ cert, key, SNICallback: (name: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => cb(null, name === "alt.localhost" ? altCtx : undefined) }, (s) => {
    serverLines.push(`sni own ${(s.getCertificate() as tls.PeerCertificate).subject.CN} ${s.getX509Certificate()?.subject}`);
    s.end("x");
  });
  server.listen(0, () => {
    const port = (server.address() as AddressInfo).port;
    const a = tls.connect({ port, ca, servername: "alt.localhost" }, () => {
      console.log("sni peer", a.getPeerCertificate().subject.CN, a.getPeerX509Certificate()?.subjectAltName);
    });
    a.resume();
    a.on("end", () => {
      flushServer();
      a.destroy();
      const b = tls.connect({ port, ca, servername: "localhost" }, () => {
        console.log("sni default peer", b.getPeerCertificate().subject.CN);
      });
      b.resume();
      b.on("end", () => {
        flushServer();
        b.destroy();
        server.close(() => done());
      });
    });
  });
});

// new tls.TLSSocket over a net connection, with a secureContext.
await new Promise<void>((done) => {
  const context = tls.createSecureContext({ cert: alt, key: altKey });
  const server = net.createServer((raw) => {
    const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
    console.log("wrap before", (secure.getCertificate() as tls.PeerCertificate).subject?.CN, secure.getX509Certificate()?.subject, JSON.stringify(secure.getPeerCertificate()));
    secure.on("secure", () => {
      serverLines.push(`wrap secure ${(secure.getCertificate() as tls.PeerCertificate).subject.CN} ${secure.getPeerX509Certificate()?.subject}`);
      secure.end("x");
    });
  });
  server.listen(0, () => {
    const c = tls.connect({ port: (server.address() as AddressInfo).port, ca, servername: "alt.localhost" }, () => {
      console.log("wrap client", chain(c.getPeerCertificate(true)));
    });
    c.resume();
    c.on("end", () => {
      flushServer();
      c.destroy();
      server.close(() => done());
    });
  });
});

// https: both sides of a request.
await new Promise<void>((done) => {
  const server = https.createServer({ cert, key }, (req, res) => {
    const s = req.socket as tls.TLSSocket;
    console.log("https server", (s.getCertificate() as tls.PeerCertificate).subject.CN, JSON.stringify(s.getPeerCertificate()));
    res.end("ok");
  });
  server.listen(0, () => {
    https.get({ port: (server.address() as AddressInfo).port, ca, host: "localhost", path: "/" }, (res) => {
      const s = res.socket as tls.TLSSocket;
      console.log("https client", chain(s.getPeerCertificate(true)), s.getPeerX509Certificate()?.issuer);
      res.resume();
      res.on("end", () => server.close(() => done()));
    });
  });
});
