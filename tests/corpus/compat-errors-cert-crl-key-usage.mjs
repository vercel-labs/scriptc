// The crl option's signer must be allowed to sign CRLs: a CA whose keyUsage
// extension is present without cRLSign reports OpenSSL's failure, exactly
// when the signature itself is fine.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/ku-leaf.pem`);
const key = readFileSync(`${D}/ku-leaf-key.pem`);
const ca = readFileSync(`${D}/ku-ca.pem`);
const crl = readFileSync(`${D}/crl-ku-clean.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
);
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca, crl });
  client.on("secureConnect", () => {
    console.log("ku", "secure", client.authorized);
    client.end();
    done(undefined);
  });
  client.on("error", (error) => {
    console.log("ku", error.code, JSON.stringify(error.message));
    done(undefined);
  });
});
server.close();
