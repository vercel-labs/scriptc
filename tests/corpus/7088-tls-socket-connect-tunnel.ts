// An HTTPS-intercepting proxy: the http server answers CONNECT, then runs
// the TLS server side on the tunnel socket with new tls.TLSSocket and a
// secureContext; the client runs its handshake inside the tunnel with
// tls.connect({ socket }). Without a servername the client verifies against
// the host the tunnel socket dialed.
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);
const context = tls.createSecureContext({
  cert: readFileSync(`${certs}/localhost.pem`),
  key: readFileSync(`${certs}/localhost-key.pem`),
});

let tunnels = 0;
const proxy = http.createServer((_req, res) => {
  res.end("plain");
});
proxy.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
  const id = ++tunnels;
  console.log(id, "proxy connect", req.method, req.url, head.length);
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
  secure.on("secure", () => console.log(id, "proxy secure", secure.getProtocol()));
  secure.on("data", (chunk: Buffer) => {
    console.log(id, "proxy got", chunk.toString());
    secure.end(`intercepted ${chunk.toString()}`);
  });
  secure.on("close", () => {
    console.log(id, "proxy tls close");
    if (id === 2) proxy.close();
  });
  socket.on("close", () => console.log(id, "tunnel close"));
});

function tunnel(port: number, servername: string | undefined, next: () => void): void {
  const raw = net.connect(port, "localhost", () => {
    raw.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
  });
  raw.once("data", (chunk: Buffer) => {
    console.log("client got", chunk.toString().split("\r\n")[0]);
    const onSecure = (): void => {
      console.log("client secureConnect", client.authorized);
      client.write(servername ?? "no servername");
    };
    const client =
      servername === undefined
        ? tls.connect({ socket: raw, ca }, onSecure)
        : tls.connect({ socket: raw, ca, servername }, onSecure);
    client.on("data", (data: Buffer) => console.log("client data", data.toString()));
    client.on("close", () => {
      console.log("client close");
      next();
    });
  });
}

proxy.listen(0, () => {
  const port = (proxy.address() as net.AddressInfo).port;
  tunnel(port, "localhost", () => tunnel(port, undefined, () => console.log("done")));
});
