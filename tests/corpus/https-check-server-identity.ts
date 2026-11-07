// https.request's options.checkServerIdentity: the callback runs once the
// chain verifies, with the servername and the peer certificate
// (getPeerCertificate(true)), and undefined lets the request stand. The
// request also pins the options the callback travels with: a Buffer ca
// from readFileSync, an explicit Host header beside a hostname that names
// another address, Content-Length, timeout and signal.
import * as https from "node:https";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const d = "tests/fixtures/server/certs";
const cert = readFileSync(`${d}/localhost.pem`);
const key = readFileSync(`${d}/localhost-key.pem`);
const ca = readFileSync(`${d}/ca.pem`);

const server = https.createServer({ cert, key }, (req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    console.log("server", req.method, req.url, req.headers.host, req.headers["content-length"]);
    console.log("body", body);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const payload = "hello";
  const controller = new AbortController();
  const req = https.request(
    {
      protocol: "https:",
      hostname: "127.0.0.1",
      port,
      path: "/ping",
      method: "POST",
      ca,
      checkServerIdentity: (host: string, peer: tls.PeerCertificate) => {
        console.log("check", host, peer.subject.CN, "issuerCertificate" in peer);
        return undefined;
      },
      headers: {
        Host: "api.localhost",
        "Content-Length": String(Buffer.byteLength(payload)),
        "content-type": "text/plain",
      },
      timeout: 5000,
      signal: controller.signal,
    },
    (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => {
        const socket = req.socket as tls.TLSSocket;
        console.log("client", res.statusCode, text, socket.authorized, socket.authorizationError);
        server.close(() => console.log("closed"));
      });
    },
  );
  req.on("error", (e: Error & { code?: string }) => {
    console.log("client error", e.code);
    server.close(() => console.log("closed"));
  });
  req.end(payload);
});
