// CERT_SIGNATURE_FAILURE: a leaf whose issuer name matches the trusted CA but
// whose signature over the TBS does not verify.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/badsig.pem`);
const key = readFileSync(`${D}/badsig-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  client.on("secureConnect", () => console.log("secureConnect", client.authorized));
  client.on("error", (error) => {
    console.log("error", error.name, error.code, JSON.stringify(error.message));
    done(undefined);
  });
  client.on("close", () => {
    server.close();
    done(undefined);
  });
});
