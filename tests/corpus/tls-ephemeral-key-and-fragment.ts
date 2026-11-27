// tlsSocket.getEphemeralKeyInfo() and setMaxSendFragment(size): the
// ephemeral-key answer's shape (null on a server-side socket and before
// the handshake; an object on an established client) and Node's size ladder
// over the boolean, including the errors for a fraction, NaN and Infinity.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const serverLines: string[] = [];
const clientLines: string[] = [];
const codeOf = (err: unknown): string => String((err as { code?: string }).code);
const messageOf = (err: unknown): string => JSON.stringify((err as Error).message);

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("error", () => {});
  const info = socket.getEphemeralKeyInfo();
  serverLines.push(`server-info ${info === null ? "null" : typeof info}`);
  for (const size of [0, 511, 512, 1000, 4096, 16384, 16385, -1]) {
    serverLines.push(`server-max-frag ${size} ${socket.setMaxSendFragment(size)}`);
  }
  socket.end(serverLines.join("\n"));
});

server.listen(0, "127.0.0.1", () => {
  const client = tls.connect(
    {
      port: (server.address() as { port: number }).port,
      host: "127.0.0.1",
      rejectUnauthorized: false,
    },
    () => {
      const info = client.getEphemeralKeyInfo();
      clientLines.push(`client-info ${info === null ? "null" : typeof info}`);
    },
  );
  client.setEncoding("utf8");
  let answered = false;
  client.on("data", () => {
    if (answered) return;
    answered = true;
    for (const size of [512, 16384, 100, 20000]) {
      clientLines.push(`client-max-frag ${size} ${client.setMaxSendFragment(size)}`);
    }
    for (const bad of [NaN, Infinity, 511.5]) {
      try {
        client.setMaxSendFragment(bad);
        clientLines.push(`bad-frag ${String(bad)} accepted`);
      } catch (err) {
        clientLines.push(`bad-frag ${String(bad)} ${codeOf(err)} ${messageOf(err)}`);
      }
    }
    client.end();
  });
  client.on("error", (err) => clientLines.push(`client-error ${codeOf(err)}`));
  client.on("close", () => {
    server.close(() => {
      console.log([...serverLines, ...clientLines, "closed"].join("\n"));
    });
  });
});
