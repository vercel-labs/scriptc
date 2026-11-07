// The blocked-SPKI policy Node 24.22.1 applies at certificate verification
// (src/crypto/crypto_context.cc, kBlockedSPKIs): a chain that contains a
// blocked public key fails as CERT_REVOKED ("certificate revoked"), and a
// chain without one verifies unchanged. The fixture's chain is
// leaf -> intermediate -> root, and a second chain (leaf -> inner
// intermediate -> outer CA -> root) reaches one CA further. The cases
// separate the certificates Node checks: every certificate of the selected
// chain, each trust-list certificate that continues the chain past the one
// mbedTLS stopped at (mbedTLS's verify callback never sees those), and, only
// when the chain itself did not verify, the peer's whole certificate list.
// A hostname mismatch is not a chain failure: Node checks the name outside
// verification, so it must not bring the unselected certificates in. An
// unrelated blocked key on a verified chain must change nothing.
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
// A second chain with one more CA level above the intermediate: the client
// trusts the intermediate, its issuer (the outer CA) and the root.
const outer = readFileSync(`${D}/i2.pem`);
const inner = readFileSync(`${D}/inter2.pem`);
const deepLeaf = readFileSync(`${D}/localhost2.pem`);
const deepLeafKey = readFileSync(`${D}/localhost2-key.pem`);
const deepChain = Buffer.concat([deepLeaf, inner]);

function listen(srv: tls.Server): Promise<void> {
  return new Promise((done) => srv.listen(0, "127.0.0.1", () => done()));
}

function port(srv: tls.Server): number {
  return (srv.address() as AddressInfo).port;
}

// A chain whose issuer is not in the trust store at all: no intermediate, so
// the peer's own list is the only candidate issuer and it does not match.
const chainUntrusted = Buffer.concat([leaf, unrelated]);

// The client's side of a handshake against a server serving `cert`, with the
// key of that certificate, under `servername` (the fixture's names resolve to
// 127.0.0.1).
function clientCase(
  name: string,
  ca: Buffer,
  reject: boolean,
  cert: Buffer,
  maxVersion?: string,
  servername = "localhost",
  key: Buffer = leafKey,
): Promise<void> {
  return new Promise((done) => {
    const srv = tls.createServer({ key, cert, maxVersion }, () => {});
    void listen(srv).then(() => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        c.destroy();
        srv.close(() => done());
      };
      const c = tls.connect({ port: port(srv), host: "127.0.0.1", ca, rejectUnauthorized: reject, servername, maxVersion });
      c.on("secureConnect", () => {
        console.log("client", name, "authorized", c.authorized, "error", c.authorizationError, "error-type", typeof c.authorizationError);
        finish();
      });
      c.on("error", (e: Error) => {
        const code = (e as NodeJS.ErrnoException).code;
        // Node appends the names the certificate does carry to this message;
        // the code and the fixed prefix are what the fixture pins, and they
        // are what separates the name error from CERT_REVOKED.
        const cut = e.message.indexOf(": ");
        const message = code === "ERR_TLS_CERT_ALTNAME_INVALID" && cut >= 0 ? e.message.slice(0, cut) : e.message;
        console.log("client", name, "failure", e.name, code, message);
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
// A name that the leaf's SANs do not hold: the chain itself verifies, so the
// peer certificate the chain did not select is never read and the name error
// is what surfaces.
await clientCase("client-wrong-name", root, true, chainWithUnrelated, undefined, "wrong.example");
// The intermediate is a trust anchor here, so mbedTLS's chain ends at it while
// Node's continues to the root the client also trusts: a blocked root is part
// of the chain Node selects, a blocked unrelated key is still not.
await clientCase("client-trusted-intermediate", Buffer.concat([inter, root]), true, chain);
// Two trust-list steps past where mbedTLS stops: the inner intermediate is
// trusted, its issuer is a clean CA the client also trusts, and that CA's
// issuer is the blocked root, which OpenSSL adds to the chain Node checks.
await clientCase("client-blocked-ancestor", Buffer.concat([inner, outer, root]), true, deepChain, undefined, "localhost", deepLeafKey);
// TLS 1.2 hands the parsed chain to verification inside a message the
// handshake releases on failure, so the unverified peer list is only reachable
// while verification runs: a blocked certificate outside the selected path
// still reports CERT_REVOKED ahead of the chain's own error.
await clientCase("client-tls12-unselected", root, true, chainUntrusted, "TLSv1.2");
await clientCase("client-tls12-default", root, true, chain, "TLSv1.2");
await serverCase("server-noreject", false);
await serverCase("server-reject", true);
