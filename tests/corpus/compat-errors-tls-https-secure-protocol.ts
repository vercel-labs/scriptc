// An https.createServer secureProtocol literal rides the runtime walk: an
// invalid method throws Node's catchable error, and TLSv1_2_method caps the
// handshake at TLS 1.2.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

try {
  https.createServer({ cert, key, secureProtocol: "bogus" }, () => {});
  console.log("https-invalid ok");
} catch (error) {
  const failure = error as NodeJS.ErrnoException;
  console.log("https-invalid", failure.code, JSON.stringify(failure.message));
}
try {
  https.createServer({ cert, key, secureProtocol: "TLSv1_2_method", minVersion: "TLSv1.2" }, () => {});
  console.log("https-conflict ok");
} catch (error) {
  const failure = error as NodeJS.ErrnoException;
  console.log("https-conflict", failure.code, JSON.stringify(failure.message));
}

const server = https.createServer(
  { cert, key, secureProtocol: "TLSv1_2_method" },
  (_request, response) => response.end("ok"),
);
server.on("tlsClientError", () => {});
const port = await new Promise<number>((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
);
await new Promise<void>((done) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  client.on("secureConnect", () => {
    console.log("https-client-negotiated", client.getProtocol());
    client.destroy();
    done();
  });
  client.on("error", (error: NodeJS.ErrnoException) => {
    console.log("https-error", error.code);
    done();
  });
});
server.close();
