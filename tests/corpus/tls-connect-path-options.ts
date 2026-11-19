// tls.connect(path, options): the Unix-socket client takes its options as an
// object literal or as a typed reference (an options binding), and the
// handshake uses them either way.
import * as tls from "node:tls";
import * as fs from "node:fs";

const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem");

const socketPath = "/tmp/scriptc-tls-path-options.sock";
fs.rmSync(socketPath, { force: true });

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.end();
});
await new Promise<void>((resolve) => server.listen(socketPath, resolve));

const options = { ca, servername: "localhost" };
await new Promise<void>((resolve) => {
  const client = tls.connect(socketPath, options, () => {
    console.log("secure", client.authorized, client.servername, client.encrypted);
    client.on("data", () => {});
    client.on("close", () => resolve());
    client.end();
  });
  client.on("error", (err: Error) => {
    console.log("client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});

server.close();
fs.rmSync(socketPath, { force: true });
