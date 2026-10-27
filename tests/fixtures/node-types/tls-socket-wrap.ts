// Under @types/node: an http CONNECT handler terminates TLS on the tunnel
// socket with new tls.TLSSocket, and the client runs its handshake inside
// the tunnel with tls.connect({ socket }).
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const proxy = http.createServer();
proxy.on("connect", (req: http.IncomingMessage, socket: net.Socket) => {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const secure = new tls.TLSSocket(socket, { isServer: true, cert, key, ALPNProtocols: ["http/1.1"] });
  secure.on("secure", () => console.log("proxy secure", req.url, secure.alpnProtocol));
  secure.on("data", (chunk: Buffer) => secure.end(`intercepted ${chunk.toString()}`));
  secure.on("close", () => proxy.close());
});
proxy.listen(0, "127.0.0.1", () => {
  const port = (proxy.address() as net.AddressInfo).port;
  const raw = net.connect(port, "127.0.0.1", () => raw.write("CONNECT example.test:443 HTTP/1.1\r\n\r\n"));
  raw.once("data", () => {
    const client = tls.connect({ socket: raw, ca, servername: "localhost", ALPNProtocols: ["http/1.1"] }, () => {
      console.log("client secureConnect", client.authorized, client.alpnProtocol);
      client.write("hello");
    });
    client.on("data", (data: Buffer) => console.log("client data", data.toString()));
  });
});
