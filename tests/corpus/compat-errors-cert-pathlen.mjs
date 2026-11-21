// PATH_LENGTH_EXCEEDED: the trust root constrains basicConstraints
// pathlen to zero, but a CA certificate sits between it and the leaf.
import { readFileSync } from "node:fs";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = Buffer.concat([readFileSync(`${D}/leafpl.pem`), readFileSync(`${D}/intpl.pem`)]);
const key = readFileSync(`${D}/leafpl-key.pem`);
const ca = readFileSync(`${D}/rootpl.pem`);

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
