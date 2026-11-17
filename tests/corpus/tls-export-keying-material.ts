// tlsSocket.exportKeyingMaterial: the exporter answers a Buffer of the
// requested length (deterministically for the same label and context), and
// its validation ladder throws Node's errors.
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
    const first = client.exportKeyingMaterial(16, "label");
    const again = client.exportKeyingMaterial(16, "label");
    const withContext = client.exportKeyingMaterial(32, "label", Buffer.from("ctx"));
    console.log(
      "ekm",
      first.length,
      withContext.length,
      Buffer.isBuffer(first),
      first.toString("hex") === again.toString("hex"),
      first.toString("hex") === withContext.subarray(0, 8).toString("hex"),
    );
    try {
      client.exportKeyingMaterial(0, "label");
    } catch (err) {
      console.log("range", (err as NodeJS.ErrnoException).code);
    }
    try {
      client.exportKeyingMaterial(16, 5 as unknown as string);
    } catch (err) {
      console.log("type", (err as NodeJS.ErrnoException).code);
    }
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
  client.on("error", (err: Error) => {
    console.log("client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});

server.close();
