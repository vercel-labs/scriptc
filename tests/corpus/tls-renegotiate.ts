// tlsSocket.renegotiate(options[, callback]): a TLS 1.2 socket starts a
// second handshake from its first 'secure' — the call answers true, a
// second 'secure' fires, and the completion runs with null after it —
// while a TLS 1.3 connection answers false and hands the engine's
// wrong-version error to the completion on the next tick. An options
// object is required and the callback must be a function; the call throws
// otherwise.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

type Version = "TLSv1.2" | "TLSv1.3";

const connect = (
  version: Version,
  setup: (client: tls.TLSSocket) => void,
): Promise<void> =>
  new Promise<void>((resolve) => {
    const server = tls.createServer(
      { key, cert, minVersion: version, maxVersion: version },
      (sock) => {
        sock.on("error", () => {});
        sock.on("data", () => {});
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      const client = tls.connect({
        port: address.port,
        host: "127.0.0.1",
        ca,
        servername: "localhost",
        minVersion: version,
        maxVersion: version,
      });
      setup(client);
      client.on("error", () => {});
      client.on("close", () => {
        server.close();
        resolve();
      });
    });
  });

const renegotiated = (): Promise<void> =>
  connect("TLSv1.2", (client) => {
    let secures = 0;
    client.on("secure", () => {
      secures += 1;
      console.log("secure", secures);
      if (secures !== 1) return;
      const started = client.renegotiate({ rejectUnauthorized: true }, (error) => {
        console.log("renegotiated", error === null, secures);
        client.end();
      });
      console.log("started", started);
    });
  });

const wrongVersion = (): Promise<void> =>
  connect("TLSv1.3", (client) => {
    client.on("secure", () => {
      const started = client.renegotiate({}, (error) => {
        const typed = error as (Error & { code?: string }) | null;
        console.log("refused", typed === null, typed?.code, typed?.message);
        client.end();
      });
      console.log("started", started);
    });
  });

const validation = (): Promise<void> =>
  connect("TLSv1.2", (client) => {
    client.on("secure", () => {
      for (const call of [
        () => client.renegotiate(undefined as unknown as object),
        () => client.renegotiate({}, 1 as unknown as (error: Error | null) => void),
      ]) {
        try {
          call();
          console.log("no throw");
        } catch (error) {
          const typed = error as Error & { code?: string };
          console.log("threw", typed.code, typed.message);
        }
      }
      client.end();
    });
  });

await renegotiated();
await wrongVersion();
await validation();
