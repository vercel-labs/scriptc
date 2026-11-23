// A renegotiation reuses the SNI context the first handshake selected: its
// client-certificate CA still governs, so a client identity the DEFAULT
// context would accept (signed by ca.pem) is refused when the selected
// context trusts only ca2.pem. The client's app data that rides the rejected
// final flight must not reach the server.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");
const defaultCa = readFileSync(dir + "ca.pem");
const contextCa = readFileSync(dir + "ca2.pem");
const clientCert = readFileSync(dir + "client.pem");
const clientKey = readFileSync(dir + "client-key.pem");

let leaked = false;
let serverError: string | null = null;
let settled = "none";
const server = tls.createServer(
  { cert, key, ca: defaultCa, maxVersion: "TLSv1.2" },
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
server.addContext("localhost", tls.createSecureContext({ cert, key, ca: contextCa }));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect(
    {
      port,
      host: "127.0.0.1",
      servername: "localhost",
      ca: defaultCa,
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
