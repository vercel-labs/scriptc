// An explicitly empty ca is an empty trust store for client certificates,
// in the server's options, in setSecureContext and in addContext, even when
// the client certificate's issuer is a default CA
// (tls.setDefaultCACertificates); an omitted ca trusts the default CAs.
// Each server has requestCert, with rejectUnauthorized false (the server's
// verdict) and true (the client is dropped).
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), cert = r("localhost.pem"), key = r("localhost-key.pem");
const alt = r("alt.pem"), altKey = r("alt-key.pem");
const client = r("client.pem"), clientKey = r("client-key.pem");

tls.setDefaultCACertificates([ca.toString()]);

function listen(server: tls.Server): Promise<number> {
  return new Promise((res) => server.listen(0, () => res((server.address() as AddressInfo).port)));
}

type Handler = (s: tls.TLSSocket) => void;

async function run(label: string, make: (h: Handler) => tls.Server, servername: string): Promise<void> {
  const events: string[] = [];
  const server = make((s) => {
    events.push(`server authorized=${s.authorized} error=${s.authorizationError}`);
    s.end("ok");
  });
  const port = await listen(server);
  await new Promise<void>((done) => {
    const c = tls.connect({ port, servername, ca, cert: client, key: clientKey });
    c.on("secureConnect", () => events.push("client secureConnect"));
    c.on("data", (d: Buffer) => events.push(`client data ${d}`));
    c.on("error", (e: NodeJS.ErrnoException) => events.push(`client error ${e.code}`));
    c.on("close", () => setTimeout(done, 50));
  });
  console.log(label, "|", events.join(" ; "));
  await new Promise<void>((res) => server.close(() => res()));
}

for (const reject of [false, true]) {
  const opts = { cert, key, requestCert: true, rejectUnauthorized: reject };
  const tag = reject ? "reject" : "request";
  await run(`${tag} omitted`, (h) => tls.createServer(opts, h), "localhost");
  await run(`${tag} empty array`, (h) => tls.createServer({ ...opts, ca: [] }, h), "localhost");
  await run(`${tag} setSecureContext empty`, (h) => {
    const server = tls.createServer(opts, h);
    server.setSecureContext({ cert, key, ca: [] });
    return server;
  }, "localhost");
  await run(`${tag} setSecureContext omitted`, (h) => {
    const server = tls.createServer({ ...opts, ca: [] }, h);
    server.setSecureContext({ cert, key });
    return server;
  }, "localhost");
  await run(`${tag} addContext empty array`, (h) => {
    const server = tls.createServer(opts, h);
    server.addContext("alt.localhost", { cert: alt, key: altKey, ca: [] });
    return server;
  }, "alt.localhost");
  await run(`${tag} addContext empty Buffer`, (h) => {
    const server = tls.createServer(opts, h);
    server.addContext("alt.localhost", tls.createSecureContext({ cert: alt, key: altKey, ca: Buffer.alloc(0) }));
    return server;
  }, "alt.localhost");
  await run(`${tag} addContext omitted`, (h) => {
    const server = tls.createServer({ ...opts, ca: [] }, h);
    server.addContext("alt.localhost", { cert: alt, key: altKey });
    return server;
  }, "alt.localhost");
}
