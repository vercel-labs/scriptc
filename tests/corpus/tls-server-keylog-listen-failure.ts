// A TLS server whose listen attempt fails still releases its listeners: the
// 'keylog' listener that captured the server and a per-job payload must not
// survive the failure (the sanitized lane's audit ends with nothing live).
import * as net from "node:net";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const taken = net.createServer();
taken.listen(0, "127.0.0.1", () => {
  const address = taken.address() as { port: number };
  const payload = "job-payload";
  let server: tls.Server | null = null;
  server = tls.createServer({ key, cert });
  const owner = server;
  owner.on("keylog", (_line: Buffer) => {
    if (server === null) console.log(payload);
  });
  owner.on("error", (error: Error & { code?: string }) => {
    console.log("listen failed", error.code);
    taken.close(() => console.log("closed"));
  });
  owner.listen(address.port, "127.0.0.1");
});
