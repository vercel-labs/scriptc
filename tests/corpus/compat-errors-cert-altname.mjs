// A trusted chain whose leaf does not name the requested host: Node reports
// ERR_TLS_CERT_ALTNAME_INVALID from checkServerIdentity, never OpenSSL's
// HOSTNAME_MISMATCH. The leaf is localhost.pem; the client asks for
// alt.localhost, which is alt.pem's SAN but not this leaf's.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "alt.localhost", ca });
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
