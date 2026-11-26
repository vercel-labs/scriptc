// https.createServer options passed as a class instance (a typed reference)
// run the same secureProtocol checks: an unknown method throws, and
// TLSv1_2_method caps the handshake at TLS 1.2.
import { readFileSync } from "node:fs";
import https from "node:https";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

class Options {
  constructor(method) {
    this.cert = cert;
    this.key = key;
    this.secureProtocol = method;
  }
}

try {
  const server = https.createServer(new Options("bogus"), () => {});
  console.log("reference-invalid ok");
  server.close();
} catch (error) {
  console.log("reference-invalid", error.code, JSON.stringify(error.message));
}

const server = https.createServer(new Options("TLSv1_2_method"), (_request, response) =>
  response.end("ok"),
);
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
);
await new Promise((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  client.on("secureConnect", () => {
    console.log("reference-negotiated", client.getProtocol());
    client.destroy();
    done(undefined);
  });
  client.on("error", (error) => {
    console.log("reference-error", error.code);
    done(undefined);
  });
});
server.close();
