// Client certificates on the other paths match Node: a server's (and a
// SecureContext's) ca completes the certificate chain it sends, as
// OpenSSL's automatic chain does; new tls.TLSSocket with requestCert and
// rejectUnauthorized, where Node reports no verdict; and https on both
// sides, including an agent that pools sockets per client certificate.
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), ca2 = r("ca2.pem"), cert = r("localhost.pem"), key = r("localhost-key.pem");
const client = r("client.pem"), clientKey = r("client-key.pem");

// A server's ca completes the chain it sends.
for (const [label, make] of [
  ["no ca", () => tls.createServer({ cert, key }, (s) => s.end())],
  ["ca", () => tls.createServer({ cert, key, ca }, (s) => s.end())],
  ["other ca", () => tls.createServer({ cert, key, ca: ca2 }, (s) => s.end())],
  // An SNI answer's own ca does not complete its chain.
  ["sni ctx ca, server no ca", () => {
    const context = tls.createSecureContext({ cert, key, ca });
    return tls.createServer({ cert, key, SNICallback: (name: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => cb(null, context) }, (s) => s.end());
  }],
] as [string, () => tls.Server][]) {
  await new Promise<void>((done) => {
    const server = make();
    server.listen(0, () => {
      const c = tls.connect({ port: (server.address() as AddressInfo).port, ca: ca2, servername: "localhost", rejectUnauthorized: false }, () => {
        const names: string[] = [];
        let p: tls.DetailedPeerCertificate | undefined = c.getPeerCertificate(true);
        for (let i = 0; p !== undefined && i < 4; i++) {
          names.push(p.subject.CN as string);
          if (p.issuerCertificate === p) break;
          p = p.issuerCertificate;
        }
        console.log(label, c.authorizationError, names.join(" -> "));
        c.destroy();
        server.close(() => done());
      });
    });
  });
}

// A TLSSocket's secureContext sends the chain its ca completes.
for (const [label, context] of [
  ["wrap ctx ca", tls.createSecureContext({ cert, key, ca })],
  ["wrap ctx", tls.createSecureContext({ cert, key })],
] as [string, tls.SecureContext][]) {
  await new Promise<void>((done) => {
    const server = net.createServer((raw) => {
      const s = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
      s.on("secure", () => s.end());
    });
    server.listen(0, () => {
      const c = tls.connect({ port: (server.address() as AddressInfo).port, ca: ca2, servername: "localhost", rejectUnauthorized: false }, () => {
        const names: string[] = [];
        let p: tls.DetailedPeerCertificate | undefined = c.getPeerCertificate(true);
        for (let i = 0; p !== undefined && i < 4; i++) {
          names.push(p.subject.CN as string);
          if (p.issuerCertificate === p) break;
          p = p.issuerCertificate;
        }
        console.log(label, c.authorizationError, names.join(" -> "));
        c.destroy();
        server.close(() => done());
      });
    });
  });
}

// new tls.TLSSocket with client certificates: Node reports no verdict there.
for (const [label, wrap] of [
  ["wrap request", (raw: net.Socket) => new tls.TLSSocket(raw, { isServer: true, cert, key, requestCert: true, ca })],
  ["wrap reject", (raw: net.Socket) => new tls.TLSSocket(raw, { isServer: true, cert, key, requestCert: true, rejectUnauthorized: true, ca })],
] as [string, (raw: net.Socket) => tls.TLSSocket][]) {
  for (const withCert of [false, true]) {
    await new Promise<void>((done) => {
      const events: string[] = [];
      const server = net.createServer((raw) => {
        const s = wrap(raw);
        s.on("secure", () => {
          events.push(`wrap secure authorized=${s.authorized} error=${s.authorizationError} peer=${(s.getPeerCertificate() as tls.PeerCertificate).subject?.CN}`);
          s.end("ok");
        });
        s.on("error", (e: NodeJS.ErrnoException) => events.push(`wrap error ${e.code}`));
      });
      server.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        const c = withCert
          ? tls.connect({ port, ca, servername: "localhost", cert: client, key: clientKey })
          : tls.connect({ port, ca, servername: "localhost" });
        c.on("secureConnect", () => events.push("client secureConnect"));
        c.on("data", (d: Buffer) => events.push(`client data ${d}`));
        c.on("error", (e: NodeJS.ErrnoException) => events.push(`client error ${e.code}`));
        c.on("close", () => {
          setTimeout(() => {
            console.log(label, withCert ? "cert" : "none", "|", events.join(" ; "));
            server.close(() => done());
          }, 50);
        });
      });
    });
  }
}

// https with client certificates, on both sides.
await new Promise<void>((done) => {
  const server = https.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca }, (req, res) => {
    const s = req.socket as tls.TLSSocket;
    res.end(`${s.authorized} ${s.authorizationError} ${(s.getPeerCertificate() as tls.PeerCertificate).subject?.CN}`);
  });
  server.listen(0, () => {
    const port = (server.address() as AddressInfo).port;
    https.get({ port, ca, host: "localhost", path: "/", cert: client, key: clientKey }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d));
      res.on("end", () => {
        console.log("https with cert", body);
        https.get({ port, ca, host: "localhost", path: "/", agent: false }, (res2) => {
          let body2 = "";
          res2.on("data", (d: Buffer) => (body2 += d));
          res2.on("end", () => {
            console.log("https without cert", body2);
            server.close(() => done());
          });
        });
      });
    });
  });
});

// An agent pools sockets per client certificate.
let connections = 0;
const server = https.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca }, (req, res) => {
  const s = req.socket as tls.TLSSocket;
  res.end(`${s.authorized} ${(s.getPeerCertificate() as tls.PeerCertificate).subject?.CN}`);
});
server.on("secureConnection", () => connections++);
function get(port: number, withCert: boolean): Promise<string> {
  return new Promise((resolve) => {
    const done = (res: http.IncomingMessage) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d));
      res.on("end", () => resolve(body));
    };
    if (withCert) https.get({ port, ca, host: "localhost", path: "/", cert: client, key: clientKey }, done);
    else https.get({ port, ca, host: "localhost", path: "/" }, done);
  });
}
server.listen(0, async () => {
  // the agent keeps one socket per client certificate
  const port = (server.address() as AddressInfo).port;
  for (const withCert of [true, true, false, false, true]) console.log(withCert, await get(port, withCert));
  console.log("connections", connections);
  server.close();
  https.globalAgent.destroy();
});
