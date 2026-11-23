// tlsSocket.getEphemeralKeyInfo(): the key-exchange group the handshake
// negotiated — { type: 'ECDH', name, size } on TLS 1.2, { type: 'TLSGroup',
// name } with no size on TLS 1.3 — and null on a server socket and after
// close. A TLS 1.2 client offers X25519 first, so both providers negotiate
// it. The TLS 1.3 group itself is the provider's pick (OpenSSL prefers its
// X25519MLKEM768 hybrid, mbedTLS the classic groups), so that line reports
// the record's shape rather than the name. Node segfaults when the call
// runs before the handshake completes, so the program does not make that
// call (the native surface answers null there); the secure-side and
// close-side lines are printed from the close handler because the client's
// handshake callback and the server's connection handler race.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

function group(socket: tls.TLSSocket, showName: boolean): string {
  const info = socket.getEphemeralKeyInfo() as tls.EphemeralKeyInfo | null;
  if (info === null) return "null";
  return `${info.type} ${showName ? info.name : info.name.length > 0} ${info.size}`;
}

function probe(label: string, maxVersion: tls.SecureVersion, showName: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let serverLine = "(server handler never ran)";
    let clientLine = "(client handshake never completed)";
    const server = tls.createServer({ cert, key }, (socket) => {
      serverLine = `${label} server ${group(socket, showName)}`;
      socket.end("");
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const client = tls.connect(
        { host: "127.0.0.1", port, servername: "localhost", ca, maxVersion },
        () => {
          clientLine = `${label} secure ${group(client, showName)}`;
        },
      );
      client.on("data", () => {});
      client.on("close", () => {
        console.log(serverLine);
        console.log(clientLine);
        console.log(label, "close", group(client, showName));
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
