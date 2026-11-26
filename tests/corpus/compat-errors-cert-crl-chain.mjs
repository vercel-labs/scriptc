// CRL checking runs over the whole built chain: the root's CRL revokes an
// intermediate that is also in `ca` (where mbedTLS alone would stop), and
// every certificate's issuer needs a CRL from that issuer.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = Buffer.concat([readFileSync(`${D}/int-leaf.pem`), readFileSync(`${D}/int-ca.pem`)]);
const key = readFileSync(`${D}/int-leaf-key.pem`);
const ca = [readFileSync(`${D}/ca.pem`), readFileSync(`${D}/int-ca.pem`)];
const leafCrl = readFileSync(`${D}/int-leaf-crl-clean.pem`);
const intClean = readFileSync(`${D}/int-crl-clean.pem`);
const intRevoked = readFileSync(`${D}/int-crl-revoked.pem`);
// Entries without a trailing newline force a separator after every entry,
// the worst case the bundle builder's allocation budgets for.
const rootOnly = readFileSync(`${D}/ca.pem`);
const caTrimmed = [readFileSync(`${D}/ca.pem`, "utf8").trimEnd(), readFileSync(`${D}/int-ca.pem`, "utf8").trimEnd()];
const crlTrimmed = [leafCrl.toString().trimEnd(), intClean.toString().trimEnd()];

for (const [label, trust, crl] of [
  ["chain-revoked-intermediate", ca, [leafCrl, intRevoked]],
  ["chain-clean", ca, [leafCrl, intClean]],
  ["chain-missing-leaf-crl", ca, [intClean]],
  ["chain-revoked-intermediate-root-only", rootOnly, [intRevoked]],
  ["chain-clean-trimmed", caTrimmed, crlTrimmed],
]) {
  const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca: trust, crl });
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

// A peer may append extra certificates the verification never uses. The CRL
// check walks the verified chain, so a self-issued decoy naming an issuer
// (here: the intermediate's subject and public key, but its own serial)
// cannot stand in for that issuer and hide the root-issued revocation.
const decoy = readFileSync(`${D}/decoy-int.pem`);
const decoyCert = Buffer.concat([readFileSync(`${D}/int-leaf.pem`), readFileSync(`${D}/int-ca.pem`), decoy]);
for (const [label, crl] of [
  ["decoy-revoked-intermediate", [leafCrl, intRevoked]],
  ["decoy-clean", [leafCrl, intClean]],
]) {
  const server = tls.createServer({ cert: decoyCert, key }, (socket) => socket.end("ok"));
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
