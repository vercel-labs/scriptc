// exportKeyingMaterial before the handshake completes: ERR_TLS_INVALID_STATE
// (Node: "TLS socket connection must be securely established"), and the
// material the established socket exports.
import tls from "node:tls";
import { readFileSync } from "node:fs";
const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const ca = readFileSync(`${D}/ca.pem`);
const server = tls.createServer({ cert, key }, (socket) => socket.end("ok"));
server.on("tlsClientError", () => {});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
await new Promise((done) => {
  const socket = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  try {
    socket.exportKeyingMaterial(16, "label");
    console.log("before connect ok");
  } catch (e) {
    console.log("before connect", e.name, e.code, JSON.stringify(e.message));
  }
  socket.on("secureConnect", () => {
    try {
      const material = socket.exportKeyingMaterial(16, "label");
      console.log("after connect", material.length);
    } catch (e) {
      console.log("after connect", e.name, e.code, JSON.stringify(e.message));
    }
    socket.end();
    server.close();
    done(undefined);
  });
  socket.on("error", () => {});
});
