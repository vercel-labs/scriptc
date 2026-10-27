// new tls.TLSSocket forms that have no lowering.
import { readFileSync } from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";

const cert = readFileSync("cert.pem");
const key = readFileSync("key.pem");
const context = tls.createSecureContext({ cert, key });
function alpn(): string[] {
  return ["h2"];
}

net.createServer((socket) => {
  // The client mode: Node starts no handshake for it.
  new tls.TLSSocket(socket, { cert, key });
  // A member after secureContext with side effects.
  new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: alpn() });
  // A secureContext that is not a SecureContext.
  new tls.TLSSocket(socket, { isServer: true, secureContext: { cert, key } });
});
