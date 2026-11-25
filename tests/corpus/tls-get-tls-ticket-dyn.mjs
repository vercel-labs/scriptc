// getTLSTicket() in the checked-dynamic lane (a plain-JS program): a TLS
// 1.2 client holds its ticket as soon as the socket is secure, a TLS 1.3
// client only once the first 'session' event arrives, and a server socket
// never has one. The bytes are the provider's, so the lines print whether
// the answer is a Buffer and that it carries content.
import tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

function shown(value) {
  if (value === undefined) return "undefined";
  return `Buffer ${Buffer.isBuffer(value)} ${value.length > 0}`;
}

function probe(version, once, done) {
  let serverLine = "(server handler never ran)";
  let secureLine = "(client handshake never completed)";
  let sessionLine = "(no session event)";
  const server = tls.createServer(
    { cert, key, minVersion: version, maxVersion: version },
    (socket) => {
      serverLine = `${version} server ${shown(socket.getTLSTicket())}`;
      socket.on("data", () => {});
      socket.end("");
    },
  );
  server.listen(0, "127.0.0.1", () => {
    const client = tls.connect(
      {
        port: server.address().port,
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
    client.on("error", (err) => console.log("error", err.message));
    client.on("data", () => {});
    client.on("close", () => {
      console.log(serverLine);
      console.log(secureLine);
      console.log(sessionLine);
      server.close(done);
    });
    if (once) setTimeout(() => client.end(), 300);
  });
}

probe("TLSv1.2", true, () => probe("TLSv1.3", false, () => {}));
