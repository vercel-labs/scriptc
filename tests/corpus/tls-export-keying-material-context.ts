// tlsSocket.exportKeyingMaterial's context argument and TLS 1.3's exporter
// label ceiling: a context changes the exported secret while the same
// context reproduces it, and a label longer than RFC 8446's 255-byte ceiling
// less the provider's prefix throws ERR_SSL_TLS_ILLEGAL_EXPORTER_LABEL on a
// TLS 1.3 connection where a TLS 1.2 connection exports it.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
    console.log("protocol", client.getProtocol());
    const plain = client.exportKeyingMaterial(32, "label");
    const withContext = client.exportKeyingMaterial(32, "label", Buffer.from("ctx"));
    const otherContext = client.exportKeyingMaterial(32, "label", Buffer.from("ctx2"));
    const repeat = client.exportKeyingMaterial(32, "label", Buffer.from("ctx"));
    console.log(
      "context",
      plain.equals(withContext),
      withContext.equals(repeat),
      withContext.equals(otherContext),
    );
    console.log(
      "empty context",
      client.exportKeyingMaterial(32, "label", Buffer.alloc(0)).equals(plain),
    );
    try {
      console.log("max label", client.exportKeyingMaterial(16, "a".repeat(249)).length);
    } catch (err) {
      console.log("max label threw", (err as NodeJS.ErrnoException).code);
    }
    try {
      client.exportKeyingMaterial(16, "a".repeat(250));
      console.log("long label", "exported");
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { library?: string; reason?: string };
      console.log("long label", e.code, e.library, e.reason, e.message);
    }
    client.end();
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
  client.on("error", (err: Error) => {
    console.log("client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});

await new Promise<void>((resolve) => {
  const client = tls.connect(
    { port, host: "127.0.0.1", ca, servername: "localhost", maxVersion: "TLSv1.2" },
    () => {
      console.log("tls12 protocol", client.getProtocol());
      console.log("tls12 long label", client.exportKeyingMaterial(16, "a".repeat(300)).length);
      console.log("tls12 reserved label", client.exportKeyingMaterial(16, "TLS_foo").length);
      client.end();
    },
  );
  client.on("data", () => {});
  client.on("close", () => resolve());
  client.on("error", (err: Error) => {
    console.log("tls12 client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});

server.close();
