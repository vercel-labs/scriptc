// A renegotiation the peer starts: the connected TLS 1.2 client calls
// renegotiate(), and the receiving server socket re-fires 'secure' for the
// handshake it completes — the initiating client sees its second 'secure'
// and then the completion. The counts are printed after the exchange so the
// two sockets' interleaving does not matter.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

let serverSecures = 0;
let clientSecures = 0;
const completed: string[] = [];

const server = tls.createServer(
  { key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" },
  (sock) => {
    sock.on("error", () => {});
    sock.on("data", () => {});
    sock.on("secure", () => {
      serverSecures += 1;
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
      console.log("client", clientSecures);
      console.log("server", serverSecures);
      console.log(completed.join(","));
      client.end();
    }, 200);
    client.on("close", () => {
      server.close();
      resolve();
    });
  });
});
