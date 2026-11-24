// The client's 'session' event: after a handshake completes, the received
// session arrives as a non-empty Buffer — for TLS 1.2 (during the
// handshake) and TLS 1.3 (its ticket after the handshake). A provider may
// deliver more than one TLS 1.3 ticket, so only presence and shape are
// compared.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const phase = (version: tls.SecureVersion): Promise<void> =>
  new Promise<void>((resolve) => {
    let sessionSeen = false;
    const server = tls.createServer({ key, cert, minVersion: version, maxVersion: version }, (sock) => {
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      const client = tls.connect(
        {
          port: address.port,
          host: "127.0.0.1",
          ca,
          servername: "localhost",
          minVersion: version,
          maxVersion: version,
        },
        () => {
          console.log(version, "secureConnect");
        },
      );
      client.on("session", (session: Buffer) => {
        if (sessionSeen) return;
        sessionSeen = true;
        console.log(version, "session", Buffer.isBuffer(session), session.length > 0);
      });
      client.on("error", () => {});
      client.on("close", () => {
        console.log(version, "session seen", sessionSeen);
        server.close();
        resolve();
      });
      setTimeout(() => client.end(), 100);
    });
  });

await phase("TLSv1.2");
await phase("TLSv1.3");
