import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
try {
  tls.createServer({ cert, key, ALPNCallback() {}, ALPNProtocols: ["h2"] });
  console.log("alpn ok");
} catch (e) { console.log("alpn", e.name, e.code, JSON.stringify(e.message)); }

const server = net.createServer((s) => s.end());
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const socket = net.connect(port, "127.0.0.1");
await new Promise((resolve) => socket.on("connect", resolve));
try {
  const options = { isServer: true, secureContext: {} };
  new tls.TLSSocket(socket, options);
  console.log("ctx ok");
} catch (e) { console.log("ctx", e.name, e.code, JSON.stringify(e.message)); }
socket.destroy(); server.close();
