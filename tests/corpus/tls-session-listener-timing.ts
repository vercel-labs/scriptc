// The client's 'session' event is not replayed: a TLS 1.2 session belongs
// to the listeners the handshake found. A listener added in the
// secureConnect callback — after the ticket rode in with the handshake —
// or later still never sees it, in Node and here.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const phase = (name: string, attach: "early" | "secureConnect" | "late"): Promise<void> =>
  new Promise<void>((resolve) => {
    let count = 0;
    let client: tls.TLSSocket;
    const server = tls.createServer({ key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }, (sock) => {
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      const seen = (): void => {
        count += 1;
      };
      client = tls.connect(
        {
          port: address.port,
          host: "127.0.0.1",
          ca,
          servername: "localhost",
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
        },
        () => {
          if (attach === "secureConnect") client.on("session", seen);
          if (attach === "late") setTimeout(() => client.on("session", seen), 50);
        },
      );
      if (attach === "early") client.on("session", seen);
      client.on("error", () => {});
      client.on("close", () => {
        console.log(name, "session count", count);
        server.close();
        resolve();
      });
      setTimeout(() => client.end(), 200);
    });
  });

await phase("early", "early");
await phase("secureConnect", "secureConnect");
await phase("late", "late");
