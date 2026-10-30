// The AsyncLocalStorage store in TLS server and client events: a server's
// connections run in its listen() context, except 'tlsClientError', which
// Node emits with no store; a client's events run in its connect() context.
import * as tls from "node:tls";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`);
const key = readFileSync(`${D}/localhost-key.pem`);
const als = new AsyncLocalStorage();
const serverEvents = [];
const clientEvents = [];
const server = tls.createServer({ cert, key }, (socket) => {
  serverEvents.push(`secureConnection ${als.getStore()}`);
  socket.on("data", () => {
    serverEvents.push(`data ${als.getStore()}`);
    socket.end("pong");
  });
});
server.on("tlsClientError", (err) => serverEvents.push(`tlsClientError ${err.code} ${als.getStore()}`));
await als.run("listen", () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
  serverEvents.push(`listening ${als.getStore()}`);
  resolve(undefined);
})));
const { port } = server.address();
await als.run("client", () => new Promise((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
    clientEvents.push(`secureConnect ${als.getStore()}`);
    client.write("ping");
  });
  client.on("data", () => clientEvents.push(`data ${als.getStore()}`));
  client.on("close", () => {
    clientEvents.push(`close ${als.getStore()}`);
    resolve(undefined);
  });
}));
await als.run("untrusted", () => new Promise((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1" });
  client.on("error", (err) => {
    clientEvents.push(`error ${err.code} ${als.getStore()}`);
    setTimeout(resolve, 100);
  });
}));
server.close(() => {
  console.log("server:", serverEvents.join(" ; "));
  console.log("client:", clientEvents.join(" ; "));
});
