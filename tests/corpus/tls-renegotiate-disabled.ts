// disableRenegotiation(): a server socket that called it reports Node's
// ERR_TLS_RENEGOTIATION_DISABLED for each peer-started renegotiation and
// keeps the connection; the handshake itself still completes, so the
// server re-fires 'secure' after the report and the initiating client sees
// its second 'secure', as OpenSSL's NO_RENEGOTIATION behaves.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

let serverError = "none";
let serverSecures = 0;
let clientSecures = 0;
const completed: string[] = [];

const server = tls.createServer(
  { key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" },
  (sock) => {
    sock.disableRenegotiation();
    sock.on("data", () => {});
    sock.on("secure", () => {
      serverSecures += 1;
    });
    sock.on("error", (error: Error & { code?: string }) => {
      if (serverError === "none") serverError = `${error.code} ${error.message}`;
    });
  },
);

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    const client = tls.connect({
      port: address.port,
      host: "127.0.0.1",
      ca,
      servername: "localhost",
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    });
    client.on("error", () => {});
    client.on("secure", () => {
      clientSecures += 1;
      if (clientSecures !== 1) return;
      const started = client.renegotiate({}, (error) => {
        completed.push(`completed:${error === null}`);
      });
      completed.push(`started:${started}`);
    });
    setTimeout(() => {
      console.log("server", serverError);
      console.log("server secures", serverSecures);
      console.log("client", clientSecures);
      console.log(completed.join(","));
      client.end();
    }, 200);
    client.on("close", () => {
      server.close();
      resolve();
    });
  });
});
