// A renegotiation whose client identity fails verification must not hand
// the program plaintext that arrived with the rejected handshake's final
// flight, and every later read/write on that socket fails. The server
// trusts ca2.pem; the client sends a ca.pem-signed certificate only on the
// renegotiation, and writes immediately afterwards so the two can coalesce.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");
const serverCa = readFileSync(dir + "ca2.pem");
const clientCa = readFileSync(dir + "ca.pem");
const clientCert = readFileSync(dir + "client.pem");
const clientKey = readFileSync(dir + "client-key.pem");

let leaked = false;
let serverError: string | null = null;
let settled = "none";
const server = tls.createServer(
  { cert, key, ca: serverCa, maxVersion: "TLSv1.2" },
  (sock: tls.TLSSocket) => {
    sock.on("data", () => {
      leaked = true;
    });
    sock.on("error", (err: Error & { code?: string }) => {
      serverError = `${err.code}`;
    });
    sock.on("close", () => {
      console.log("server", "leaked", leaked, "settled", settled, "error", serverError);
      server.close();
    });
    sock.renegotiate({ requestCert: true, rejectUnauthorized: true }, (err) => {
      settled = err === null ? "ok" : "error";
    });
  },
);
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect(
    {
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca: clientCa,
      cert: clientCert,
      key: clientKey,
      rejectUnauthorized: false,
      maxVersion: "TLSv1.2",
    },
    () => {
      console.log("client secure");
    },
  );
  let secures = 0;
  client.on("secure", () => {
    secures += 1;
    // the renegotiation's completion: the app data that rides the final
    // flight (the server must not hand it to the program)
    if (secures === 2) client.write("secret-after-flight");
  });
  client.on("error", (err: Error & { code?: string }) => {
    console.log("client error", err.code);
  });
  client.on("data", () => {});
  setTimeout(() => client.end(), 1500);
});
