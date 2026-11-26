// tls.connect({ crl }): a revoked certificate, a CRL outside its validity
// window, one signed by another CA, and a CRL whose signature does not
// verify each report Node's code and message from client verification.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/crl-leaf.pem`);
const key = readFileSync(`${D}/crl-leaf-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

try {
  tls.connect({ port: 1, host: "127.0.0.1", crl: "not a crl" }).on("error", () => {});
  console.log("malformed constructed");
} catch (error) {
  console.log("malformed", error.name, error.code, JSON.stringify(error.message));
}

// Array forms: Node/OpenSSL keeps the first CRL per issuer, so a clean CRL
// ahead of a revoking one for the same CA verifies; the reverse revokes.
const cleanCrl = readFileSync(`${D}/crl-clean.pem`);
const revokedCrl = readFileSync(`${D}/crl-revoked.pem`);
const expiredCrl = readFileSync(`${D}/crl-expired.pem`);
const futureCrl = readFileSync(`${D}/crl-future.pem`);
const badsigCrl = readFileSync(`${D}/crl-badsig.pem`);
for (const [name, crl] of [
  ["crl-clean", readFileSync(`${D}/crl-clean.pem`)],
  ["crl-revoked", revokedCrl],
  ["crl-expired", readFileSync(`${D}/crl-expired.pem`)],
  ["crl-future", readFileSync(`${D}/crl-future.pem`)],
  ["crl-badsig", readFileSync(`${D}/crl-badsig.pem`)],
  ["crl-untrusted", readFileSync(`${D}/crl-untrusted.pem`)],
  ["crl-root-revoked", readFileSync(`${D}/crl-root-revoked.pem`)],
  ["crl-array-single", [revokedCrl]],
  ["crl-array-first", [cleanCrl, revokedCrl]],
  ["crl-array-last", [revokedCrl, cleanCrl]],
  ["crl-array-strings", [cleanCrl.toString(), revokedCrl.toString()]],
  ["crl-array-expired-first", [expiredCrl, cleanCrl]],
  ["crl-array-future-first", [futureCrl, cleanCrl]],
  ["crl-array-badsig-first", [badsigCrl, cleanCrl]],
  ["crl-array-expired-badsig", [expiredCrl, badsigCrl, cleanCrl]],
  ["crl-array-expired-clean-badsig", [expiredCrl, cleanCrl, badsigCrl]],
  ["crl-array-expired-revoked", [expiredCrl, revokedCrl]],
]) {
  const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      crl,
    });
    client.on("secureConnect", () => {
      console.log(name, "secure", client.authorized);
      client.end();
      done(undefined);
    });
    client.on("error", (error) => {
      console.log(name, error.name, error.code, JSON.stringify(error.message));
      done(undefined);
    });
  });
  server.close();
}

{
  // rejectUnauthorized: false still RUNS verification: the socket reports
  // the CRL verdict instead of failing the handshake.
  const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  await new Promise((done) => {
    const client = tls.connect({
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca,
      crl: readFileSync(`${D}/crl-revoked.pem`),
      rejectUnauthorized: false,
    });
    client.on("secureConnect", () => {
      console.log("relaxed", client.authorized, client.authorizationError);
      client.end();
      done(undefined);
    });
    client.on("error", (error) => {
      console.log("relaxed", error.code);
      done(undefined);
    });
  });
  server.close();
}
