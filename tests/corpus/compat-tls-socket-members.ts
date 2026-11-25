// The TypeScript twin of compat-tls-socket-members.mjs: TLSSocket members
// on both ends of a loopback connection, from a typed source.
// 'secureConnect' on the client, 'connection' and 'secureConnection' on
// the server, address(), encrypted, the local and remote addresses and
// ports, getCipher() and isSessionReused().
import * as tls from "node:tls";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const lines: string[] = [];
const server = tls.createServer({ key, cert });
server.on("connection", () => lines.push("server connection"));
server.on("secureConnection", (socket) => {
  lines.push(`server secureConnection ${socket.encrypted} ${socket.authorized}`);
  socket.end("hi");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca });
  client.on("secureConnect", () => {
    const cipher = client.getCipher();
    const address = client.address() as AddressInfo;
    lines.push(`client secureConnect ${client.authorized} ${client.encrypted}`);
    lines.push(`client address ${typeof address.port} ${address.family} ${address.address}`);
    lines.push(`client local ${client.localAddress} ${typeof client.localPort}`);
    lines.push(`client remote ${client.remoteAddress} ${client.remoteFamily} ${client.remotePort === port}`);
    lines.push(`client cipher ${Object.keys(cipher).sort().join(",")} ${cipher.version}`);
    lines.push(`client reused ${client.isSessionReused()}`);
  });
  client.on("data", (chunk) => lines.push(`client data ${chunk}`));
  client.on("close", () =>
    server.close(() => {
      // The two ends run concurrently, so the lines are sorted.
      for (const line of lines.sort()) console.log(line);
    }),
  );
});
