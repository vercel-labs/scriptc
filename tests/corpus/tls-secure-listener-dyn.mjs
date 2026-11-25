// A JavaScript program's checked-dynamic registration: on('connection')
// runs at TCP acceptance and on('secureConnection') after the handshake,
// each with the socket kind Node hands it, and both keep a listener of
// their own.
import * as tls from "node:tls";
import { readFileSync, rmSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const events = [];
const server = tls.createServer({ key, cert }, (socket) => {
  events.push(`handler:${socket.encrypted}`);
  socket.on("data", () => {});
  socket.end("ok");
});
server.on("connection", () => events.push("connection"));
server.on("secureConnection", (socket) => events.push(`secure:${socket.encrypted === true}`));
server.once("secureConnection", () => events.push("secure once"));

/* one bind path per process: the differential and llvm-differential
 * suites run this program at the same time in one job */
const path = `/tmp/scriptc-tls-dyn-secure-${process.pid}.sock`;
rmSync(path, { force: true });
await new Promise((resolve) => server.listen(path, resolve));

let clientSecure = false;
await new Promise((resolve) => {
  const client = tls.connect({ path, ca, servername: "localhost" }, () => {
    clientSecure = true;
  });
  client.on("data", () => {});
  client.on("close", resolve);
  client.on("error", (err) => {
    events.push(`client error:${err.code}`);
    resolve();
  });
});

console.log("client secure", clientSecure);
console.log("events", events.join(","));
server.close();
rmSync(path, { force: true });
