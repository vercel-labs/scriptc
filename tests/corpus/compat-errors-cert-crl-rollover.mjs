// A key-rollover CA and the root it replaced share a subject DN but not a
// key. The chain must continue past the trusted rollover certificate to the
// root, and the first CRL for that issuer name decides each certificate's
// answer, like OpenSSL's store: the rollover CA's own clean CRL hides
// nothing, and the root's CRL revoking it reports CERT_REVOKED.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/rollover-leaf.pem`);
const key = readFileSync(`${D}/rollover-leaf-key.pem`);
const ca = [readFileSync(`${D}/ca.pem`), readFileSync(`${D}/rollover-ca.pem`)];
const rolloverClean = readFileSync(`${D}/crl-rollover-clean.pem`);
const rolloverRevoked = readFileSync(`${D}/crl-rollover-revoked.pem`);
const rootClean = readFileSync(`${D}/crl-clean.pem`);

for (const [label, crl] of [
  ["rollover-clean-first", [rolloverClean, rootClean]],
  ["rollover-revoked-first", [rolloverClean, rolloverRevoked]],
  ["rollover-root-only", [rolloverRevoked]],
]) {
  const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca, crl });
    client.on("secureConnect", () => {
      console.log(label, "secure", client.authorized);
      client.end();
      done(undefined);
    });
    client.on("error", (error) => {
      console.log(label, error.code, JSON.stringify(error.message));
      done(undefined);
    });
  });
  server.close();
}
