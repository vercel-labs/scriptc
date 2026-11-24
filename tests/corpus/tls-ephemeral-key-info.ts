// tlsSocket.getEphemeralKeyInfo(): the ephemeral key the handshake
// exchanged — { type: 'ECDH', name, size } for a classic elliptic-curve
// key (every group this engine negotiates, on either TLS version; OpenSSL
// spells its non-EC TLS 1.3 hybrid X25519MLKEM768 TLSGroup, with no size)
// — and null on a server socket and after close. A TLS 1.2 client offers
// X25519 first, so both providers negotiate it and that record matches
// exactly; the TLS 1.3 group is the provider's pick, so that line checks
// that the type and the presence of the size agree. Node segfaults when
// the call runs before the handshake completes, so the program does not
// make that call (the native surface answers null there); the secure-side
// and close-side lines are printed from the close handler because the
// client's handshake callback and the server's connection handler race.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

function group(socket: tls.TLSSocket, exact: boolean): string {
  const info = socket.getEphemeralKeyInfo() as tls.EphemeralKeyInfo | null;
  if (info === null) return "null";
  if (exact) return `${info.type} ${info.name} ${info.size}`;
  // a classic curve key carries its bit size and is spelled ECDH; a
  // provider's non-EC TLS 1.3 hybrid is spelled TLSGroup and carries none
  const agrees = info.type === (info.size === undefined ? "TLSGroup" : "ECDH");
  return `${agrees} ${info.name.length > 0}`;
}

function probe(label: string, maxVersion: tls.SecureVersion, exact: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let serverLine = "(server handler never ran)";
    let clientLine = "(client handshake never completed)";
    const server = tls.createServer({ cert, key }, (socket) => {
      serverLine = `${label} server ${group(socket, exact)}`;
      socket.end("");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const client = tls.connect(
        { host: "127.0.0.1", port, servername: "localhost", ca, maxVersion },
        () => {
          clientLine = `${label} secure ${group(client, exact)}`;
        },
      );
      client.on("data", () => {});
      client.on("close", () => {
        console.log(serverLine);
        console.log(clientLine);
        console.log(label, "close", group(client, exact));
        server.close(() => resolve());
      });
    });
  });
}

async function main(): Promise<void> {
  await probe("tls12", "TLSv1.2", true);
  await probe("tls13", "TLSv1.3", false);
}

void main();
