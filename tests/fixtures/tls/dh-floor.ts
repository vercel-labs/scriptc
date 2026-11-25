// One TLS connection per `label=port` argument, each to a server that
// offers only a finite-field Diffie-Hellman suite with a group of the size
// its label names. Prints whether the client accepted the group.
import { readFileSync } from "node:fs";
import * as tls from "node:tls";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
for (const target of process.argv.slice(2)) {
  const at = target.indexOf("=");
  const label = target.slice(0, at);
  const port = Number(target.slice(at + 1));
  await new Promise<void>((done) => {
    let outcome = "refused";
    const socket = tls.connect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => {
      outcome = "connected";
      socket.end();
    });
    socket.on("error", () => {});
    socket.resume();
    socket.on("close", () => {
      console.log(label, outcome);
      done();
    });
  });
}
