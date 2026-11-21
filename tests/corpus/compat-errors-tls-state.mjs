// TLS socket state errors: exporting keying material before the handshake
// finishes, and issuing SNI from a server-side socket.
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);

const client = tls.connect({ port: 1, host: "127.0.0.1", servername: "localhost", ca });
try {
  console.log("export", client.exportKeyingMaterial(16, "label").toString("hex"));
} catch (error) {
  console.log("export", error.name, error.code, JSON.stringify(error.message));
}
client.destroy();

const server = tls.createServer({ cert, key }, (socket) => {
  try {
    console.log("sni", socket.setServername("alt.localhost"), socket.servername);
  } catch (error) {
    console.log("sni", error.name, error.code, JSON.stringify(error.message));
  }
  socket.end();
});
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
await new Promise((done) => {
  const c = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  c.on("secureConnect", () => c.end());
  c.on("close", () => done(undefined));
});
server.close();
