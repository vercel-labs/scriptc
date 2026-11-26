// A SecureContext built with TLSv1_2_method carries its version bounds into
// a server-mode TLSSocket created from it.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const context = tls.createSecureContext({
  cert: readFileSync(`${D}/localhost.pem`),
  key: readFileSync(`${D}/localhost-key.pem`),
  secureProtocol: "TLSv1_2_method",
});

const plain = net.createServer((socket: net.Socket) => {
  const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
  wrapped.on("secure", () => {
    console.log("context-negotiated", wrapped.getProtocol());
    wrapped.end();
  });
  wrapped.on("error", () => {});
});
const port = await new Promise<number>((resolve) =>
  plain.listen(0, "127.0.0.1", () => resolve((plain.address() as net.AddressInfo).port)),
);
await new Promise<void>((done) => {
  const client = tls.connect({
    port,
    host: "127.0.0.1",
    servername: "localhost",
    ca: readFileSync(`${D}/ca.pem`),
  });
  client.on("secureConnect", () => client.end());
  client.on("close", () => done());
});
plain.close();
