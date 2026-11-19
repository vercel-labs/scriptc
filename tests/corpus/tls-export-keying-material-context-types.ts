// The exporter's context is a byte range: a multi-byte typed array's whole
// contents reach the provider, so two Uint16Array contexts that differ after
// their first byte must not produce the same keying material, and a view's
// window is what counts.
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
    const low = client.exportKeyingMaterial(32, "label", new Uint16Array([1, 2]));
    const high = client.exportKeyingMaterial(32, "label", new Uint16Array([1, 3]));
    console.log("u16 differ", !low.equals(high));
    console.log(
      "u16 repeat",
      low.equals(client.exportKeyingMaterial(32, "label", new Uint16Array([1, 2]))),
    );
    const buffer = new Uint8Array([9, 9, 1, 2, 3, 4]);
    const shortView = new DataView(buffer.buffer, 2, 2);
    const longView = new DataView(buffer.buffer, 2, 4);
    console.log(
      "view differ",
      !client
        .exportKeyingMaterial(32, "label", shortView)
        .equals(client.exportKeyingMaterial(32, "label", longView)),
    );
    console.log(
      "view repeat",
      client
        .exportKeyingMaterial(32, "label", shortView)
        .equals(client.exportKeyingMaterial(32, "label", shortView)),
    );
    client.end();
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
  client.on("error", (err: Error) => {
    console.log("client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});

server.close();
