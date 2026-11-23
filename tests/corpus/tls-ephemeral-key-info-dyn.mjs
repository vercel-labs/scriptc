// getEphemeralKeyInfo() in the checked-dynamic lane (a plain-JS program):
// the group record on a TLS 1.2 client, the record's shape on TLS 1.3 (the
// name is the engine's pick), and null on the server end and after close.
import tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

function group(socket, showName) {
  const info = socket.getEphemeralKeyInfo();
  if (info === null) return "null";
  return `${info.type} ${showName ? info.name : info.name.length > 0} ${info.size}`;
}

function probe(label, maxVersion, showName, done) {
  let serverLine = "(server handler never ran)";
  let clientLine = "(client handshake never completed)";
  const server = tls.createServer({ cert, key }, (socket) => {
    serverLine = `${label} server ${group(socket, showName)}`;
    socket.end("");
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
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
      server.close(done);
    });
  });
}

probe("tls12", "TLSv1.2", true, () => probe("tls13", "TLSv1.3", false, () => {}));
