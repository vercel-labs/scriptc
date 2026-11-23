// The 'keylog' event: Node's NSS key-log lines as Buffers, on a TLSSocket
// and on a tls.Server (whose listener sees its connections' lines), over a
// TLS 1.2 handshake: one "CLIENT_RANDOM <client_random hex> <master secret
// hex>\n" line per side. The lines are printed sorted per side so the two
// emitters' interleaving does not matter.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const describe = (line: Buffer): string => {
  const text = line.toString();
  const body = text.replace(/\n$/, "");
  const parts = body.split(" ");
  const shape = parts.map((part) => (/^[0-9a-f]+$/.test(part) ? part.length : part)).join(",");
  return `${shape}${text.endsWith("\n") ? ":nl" : ""}`;
};

const phase = (version: tls.SecureVersion): Promise<void> =>
  new Promise<void>((resolve) => {
    const clientLines: string[] = [];
    const serverLines: string[] = [];
    const server = tls.createServer({ key, cert, maxVersion: version });
    server.on("keylog", (line: Buffer) => serverLines.push(describe(line)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      const client = tls.connect(
        { port: address.port, host: "127.0.0.1", ca, servername: "localhost", maxVersion: version },
        () => {
          client.end();
        },
      );
      client.on("keylog", (line: Buffer) => clientLines.push(describe(line)));
      client.on("error", () => {});
      client.on("close", () => {
        server.close(() => {
          console.log(version, "client", clientLines.sort().join("|"));
          console.log(version, "server", serverLines.sort().join("|"));
          resolve();
        });
      });
    });
  });

// TLS 1.2: the whole key log (one CLIENT_RANDOM line per side).
await phase("TLSv1.2");
