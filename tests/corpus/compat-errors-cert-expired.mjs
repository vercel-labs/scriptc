// CERT_HAS_EXPIRED: a trusted certificate whose validity window has passed.
// The fixture is self-signed, so the client trusts it through `ca` and the
// only verification failure left is the expiry.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/expired.pem`);
const key = readFileSync(`${D}/expired-key.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca: cert });
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
