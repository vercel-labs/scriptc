// disableRenegotiation() has no effect, but the receiver expression is still
// evaluated: its side effects run and its exception propagates.
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
  let receiverCalls = 0;
  const client = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
    const getSocket = (): tls.TLSSocket => {
      receiverCalls++;
      console.log("receiver", receiverCalls);
      return client;
    };
    getSocket().disableRenegotiation();
    console.log("after call", receiverCalls);
    const boom = (): tls.TLSSocket => {
      throw new Error("receiver threw");
    };
    try {
      boom().disableRenegotiation();
    } catch (err) {
      console.log("caught", (err as Error).message);
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
