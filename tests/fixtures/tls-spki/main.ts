// The blocked-SPKI policy Node 24.22.1 applies at certificate verification
// (src/crypto/crypto_context.cc, kBlockedSPKIs): a chain that contains a
// blocked public key fails as CERT_REVOKED ("certificate revoked"), and a
// chain without one verifies unchanged. The fixture's chain is
// leaf -> intermediate -> root, so the cases separate the certificates Node
// checks: every certificate of the selected chain, the trust anchor that
// ended it (which mbedTLS's verify callback never sees), and, only when the
// chain did not verify, the peer's whole certificate list. An unrelated
// blocked key on a verified chain must change nothing.
//
// One of the fixture's public keys is injected as blocked per run:
// node-hook.cjs adds it through Node's internal binding hook and the native
// runtime reads the same digest from SCRIPTC_TLS_BLOCKED_SPKI.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/tls-spki";
const root = readFileSync(`${D}/root.pem`);
const inter = readFileSync(`${D}/inter.pem`);
const unrelated = readFileSync(`${D}/unrelated.pem`);
const leaf = readFileSync(`${D}/localhost.pem`);
const leafKey = readFileSync(`${D}/localhost-key.pem`);
const client = readFileSync(`${D}/client.pem`);
const clientKey = readFileSync(`${D}/client-key.pem`);
const chain = Buffer.concat([leaf, inter]);
const clientChain = Buffer.concat([client, inter]);
const chainWithUnrelated = Buffer.concat([chain, unrelated]);

function listen(srv: tls.Server): Promise<void> {
  return new Promise((done) => srv.listen(0, "127.0.0.1", () => done()));
}

function port(srv: tls.Server): number {
  return (srv.address() as AddressInfo).port;
}

// A chain whose issuer is not in the trust store at all: no intermediate, so
// the peer's own list is the only candidate issuer and it does not match.
const chainUntrusted = Buffer.concat([leaf, unrelated]);

// The client's side of a handshake against a server serving `cert`.
function clientCase(name: string, ca: Buffer, reject: boolean, cert: Buffer): Promise<void> {
  return new Promise((done) => {
    const srv = tls.createServer({ key: leafKey, cert }, () => {});
    void listen(srv).then(() => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        c.destroy();
        srv.close(() => done());
      };
      const c = tls.connect({ port: port(srv), host: "127.0.0.1", ca, rejectUnauthorized: reject, servername: "localhost" });
      c.on("secureConnect", () => {
        console.log("client", name, "authorized", c.authorized, "error", c.authorizationError, "error-type", typeof c.authorizationError);
        finish();
      });
      c.on("error", (e: Error) => {
        console.log("client", name, "failure", e.name, (e as NodeJS.ErrnoException).code, e.message);
        finish();
      });
    });
  });
}

// The server's side of a handshake with a client certificate chain.
function serverCase(name: string, reject: boolean): Promise<void> {
  return new Promise((done) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      srv.close(() => done());
    };
    const srv = tls.createServer({ key: leafKey, cert: chain, ca: root, requestCert: true, rejectUnauthorized: reject }, (sock) => {
      console.log("server", name, "authorized", sock.authorized, "error", sock.authorizationError);
      sock.end();
      finish();
    });
    srv.on("tlsClientError", (e: Error, sock: tls.TLSSocket) => {
      console.log("server", name, "tlsClientError", (e as NodeJS.ErrnoException).code, e.message, "socket-error", sock.authorizationError);
      finish();
    });
    void listen(srv).then(() => {
      const c = tls.connect({ port: port(srv), host: "127.0.0.1", ca: root, cert: clientChain, key: clientKey, servername: "localhost" });
      c.on("error", () => {});
      c.resume();
    });
  });
}

await clientCase("client-default", root, true, chain);
await clientCase("client-noreject", root, false, chain);
await clientCase("client-empty-ca", Buffer.alloc(0), true, chainUntrusted);
await clientCase("client-verified-unrelated", root, true, chainWithUnrelated);
await serverCase("server-noreject", false);
await serverCase("server-reject", true);
