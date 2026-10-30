// A server's ca option as a trust store for client certificates, run with
// NODE_EXTRA_CA_CERTS naming the test CA, so the default store trusts the
// client: an empty Buffer is an empty store, an empty string and no ca use
// the default store.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const cert = r("localhost.pem"), key = r("localhost-key.pem"), ca = r("ca.pem");
const cases: [string, Buffer | string | undefined][] = [
  ["empty Buffer", Buffer.alloc(0)],
  ["empty string", ""],
  ["no ca", undefined],
  ["ca", ca],
];
for (const [label, value] of cases) {
  await new Promise<void>((done) => {
    const report = (s: tls.TLSSocket): void => {
      console.log(label, s.authorized, s.authorizationError);
      s.end();
    };
    const server =
      value === undefined
        ? tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false }, report)
        : tls.createServer({ cert, key, requestCert: true, rejectUnauthorized: false, ca: value }, report);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const c = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost", cert: r("client.pem"), key: r("client-key.pem") });
      c.on("error", () => {});
      c.resume();
      c.on("close", () => server.close(() => done()));
    });
  });
}
