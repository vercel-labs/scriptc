// Two renegotiations on one TLS 1.2 client, over a connection whose verify
// walk RECORDS its verdict (rejectUnauthorized:false maps to the engine's
// optional mode, so the peer's self-signed chain is walked and its failure
// recorded rather than fatal). Each renegotiation runs the walk again — the
// engine has freed the previous chain by then — and the second 'secure'
// and completion still follow, as in Node.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

let secures = 0;
const server = tls.createServer({ key, cert, maxVersion: "TLSv1.2" }, (sock) => {
  sock.on("error", () => {});
  sock.on("data", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect({
    port,
    host: "127.0.0.1",
    servername: "localhost",
    rejectUnauthorized: false,
    maxVersion: "TLSv1.2",
  });
  client.on("error", (err: Error) => console.log("error", err.message));
  client.on("secure", () => {
    secures += 1;
    console.log("secure", secures);
    if (secures !== 1) return;
    client.renegotiate({}, (first) => {
      console.log("first", first === null);
      client.renegotiate({}, (second) => {
        console.log("second", second === null);
        client.end();
      });
    });
  });
  client.on("data", () => {});
  client.on("close", () => {
    server.close(() => console.log("closed"));
  });
});
