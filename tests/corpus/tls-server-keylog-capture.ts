// A TLS server's 'keylog' listener may capture the server itself. Closing
// the server releases its listeners, so the server → TLS context → closure
// cycle is freed along with the per-job payload that came with it.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const rounds = 2;
let closed = 0;

const one = (round: number): void => {
  const payload = `payload-${round}`;
  let server: tls.Server | null = null;
  server = tls.createServer({ key, cert }, (sock) => {
    sock.on("error", () => {});
  });
  const owner = server;
  owner.on("keylog", (_line: Buffer) => {
    /* the listener reads state it reached through the captured server */
    if (server === null) console.log(payload);
  });
  owner.listen(0, "127.0.0.1", () => {
    console.log("listening", payload);
    owner.close(() => {
      closed += 1;
      if (round + 1 < rounds) {
        one(round + 1);
        return;
      }
      console.log("closed", closed);
    });
  });
};

one(0);
