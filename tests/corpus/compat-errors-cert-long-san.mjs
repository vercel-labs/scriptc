// A long URI subjectAltName on a hostname-mismatching certificate: the
// altname failure message carries the SAN rendering in full.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/long-san.pem`);
const key = readFileSync(`${D}/long-san-key.pem`);

const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "alt.localhost", ca: cert });
  client.on("secureConnect", () => {
    console.log("secureConnect", client.authorized);
    client.end();
    done(undefined);
  });
  client.on("error", (error) => {
    console.log("error", error.name, error.code, JSON.stringify(error.message));
    done(undefined);
  });
});
server.close();
