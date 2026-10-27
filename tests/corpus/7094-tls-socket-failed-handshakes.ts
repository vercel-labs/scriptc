// A TLSSocket whose handshake never completes still closes and releases
// its listeners, including a 'secure' listener that holds the socket: one
// peer closes before sending anything and the next sends a plain HTTP
// request.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);
const context = tls.createSecureContext({ cert, key });

const peers: ((port: number) => void)[] = [
  (port) => {
    const quiet = net.connect(port, "127.0.0.1", () => quiet.end());
  },
  (port) => {
    const plain = net.connect(port, "127.0.0.1", () => plain.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    plain.on("error", () => {});
    plain.resume();
  },
  (port) => {
    const quiet = net.connect(port, "127.0.0.1", () => quiet.destroy());
  },
];
let served = 0;
const server = net.createServer((raw) => {
  served++;
  const secure =
    served === 3
      ? new tls.TLSSocket(raw, { isServer: true, secureContext: context })
      : new tls.TLSSocket(raw, { isServer: true, cert, key });
  secure.on("secure", () => console.log("secure", served, secure.alpnProtocol));
  secure.on("error", (err: NodeJS.ErrnoException) => console.log("error", served, err.code));
  secure.on("close", (hadError: boolean) => {
    console.log("close", served, hadError);
    next();
  });
});
function next(): void {
  const peer = peers.shift();
  if (peer === undefined) {
    server.close(() => console.log("server closed"));
    return;
  }
  peer((server.address() as net.AddressInfo).port);
}
server.listen(0, "127.0.0.1", next);
