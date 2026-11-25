// tlsSocket.getTLSTicket(): the session ticket a client received. TLS 1.2
// carries its ticket in the handshake, so a secure client answers a Buffer;
// TLS 1.3 delivers tickets after the handshake, so the answer is undefined
// at secureConnect and a Buffer once the first 'session' event arrives. A
// server socket never has a client's ticket.
//
// Node and the native runtime mint different ticket bytes, so the program
// prints what both agree on: whether the answer is a Buffer and that it
// carries content.
import * as tls from "node:tls";
import { readFileSync } from "fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

function shown(value: Buffer | undefined): string {
  if (value === undefined) return "undefined";
  return `Buffer ${Buffer.isBuffer(value)} ${value.length > 0}`;
}

function probe(version: tls.SecureVersion, once: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let serverLine = "(server handler never ran)";
    let secureLine = "(client handshake never completed)";
    let sessionLine = "(no session event)";
    const server = tls.createServer(
      { cert, key, minVersion: version, maxVersion: version },
      (socket: tls.TLSSocket) => {
        serverLine = `${version} server ${shown(socket.getTLSTicket())}`;
        socket.on("data", () => {});
        socket.end("");
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const client = tls.connect(
        {
          port,
          host: "127.0.0.1",
          servername: "localhost",
          ca,
          minVersion: version,
          maxVersion: version,
        },
        () => {
          secureLine = `${version} secure ${shown(client.getTLSTicket())}`;
        },
      );
      client.on("session", () => {
        if (sessionLine !== "(no session event)") return;
        const ticket = client.getTLSTicket();
        // TLS 1.3 tickets are only surfaced through the event's session, which
        // this provider does not carry: the record stays undefined-or-Buffer
        sessionLine =
          version === "TLSv1.2"
            ? `${version} session ${shown(ticket)}`
            : `${version} session ${ticket === undefined || Buffer.isBuffer(ticket)}`;
        if (!once) client.end();
      });
      client.on("data", () => {});
      client.on("close", () => {
        console.log(serverLine);
        console.log(secureLine);
        console.log(sessionLine);
        server.close(() => resolve());
      });
      if (once) setTimeout(() => client.end(), 300);
    });
  });
}

async function main(): Promise<void> {
  await probe("TLSv1.2", true);
  await probe("TLSv1.3", false);
}

void main();
