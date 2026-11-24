// getEphemeralKeyInfo() in the checked-dynamic lane (a plain-JS program):
// the ephemeral key record on a TLS 1.2 client (both providers negotiate
// X25519 there, so it matches exactly), the type/size agreement on TLS 1.3
// (the group itself is the provider's pick), and null on the server end and
// after close.
import tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

function group(socket, exact) {
  const info = socket.getEphemeralKeyInfo();
  if (info === null) return "null";
  if (exact) return `${info.type} ${info.name} ${info.size}`;
  const agrees = info.type === (info.size === undefined ? "TLSGroup" : "ECDH");
  return `${agrees} ${info.name.length > 0}`;
}

function probe(label, maxVersion, exact, done) {
  let serverLine = "(server handler never ran)";
  let clientLine = "(client handshake never completed)";
  const server = tls.createServer({ cert, key }, (socket) => {
    serverLine = `${label} server ${group(socket, exact)}`;
    socket.end("");
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
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
      server.close(done);
    });
  });
}

probe("tls12", "TLSv1.2", true, () => probe("tls13", "TLSv1.3", false, () => {}));
