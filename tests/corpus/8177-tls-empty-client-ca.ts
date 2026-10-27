// An explicitly empty ca is an empty trust store for a client's view of
// the server certificate, in tls.connect, https.request and http2.connect,
// even when the server certificate's issuer is a default CA
// (tls.setDefaultCACertificates); an omitted ca, or an empty string, trusts
// the default CAs.
import { readFileSync } from "node:fs";
import * as http2 from "node:http2";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), key = r("localhost-key.pem");
// The servers send their issuer too, so each client sees the same chain.
const cert = Buffer.concat([r("localhost.pem"), ca]);

tls.setDefaultCACertificates([ca.toString()]);

function listen(server: tls.Server | https.Server | http2.Http2SecureServer): Promise<number> {
  return new Promise((res) => server.listen(0, () => res((server.address() as AddressInfo).port)));
}

async function watch(label: string, c: tls.TLSSocket): Promise<void> {
  const events: string[] = [];
  await new Promise<void>((done) => {
    c.on("secureConnect", () => {
      events.push(`secureConnect authorized=${c.authorized} error=${c.authorizationError}`);
      c.end();
    });
    c.on("error", (e: NodeJS.ErrnoException) => events.push(`error ${e.code}`));
    c.on("close", () => done());
  });
  console.log("tls.connect", label, "|", events.join(" ; "));
}

{
  const server = tls.createServer({ cert, key }, (s) => s.end());
  const port = await listen(server);
  const host = "localhost";
  await watch("omitted", tls.connect({ port, host }));
  await watch("empty string", tls.connect({ port, host, ca: "" }));
  await watch("empty Buffer", tls.connect({ port, host, ca: Buffer.alloc(0) }));
  await watch("empty array", tls.connect({ port, host, ca: [] }));
  await watch(
    "empty Buffer, rejectUnauthorized false",
    tls.connect({ port, host, ca: Buffer.alloc(0), rejectUnauthorized: false }),
  );
  await watch("empty array, rejectUnauthorized false", tls.connect({ port, host, ca: [], rejectUnauthorized: false }));
  server.close();
}

function report(label: string, req: ReturnType<typeof https.request>, done: () => void): void {
  req.on("response", (res) => {
    console.log("https.request", label, "| status", res.statusCode);
    res.resume();
    res.on("end", done);
  });
  req.on("error", (e: NodeJS.ErrnoException) => {
    console.log("https.request", label, "| error", e.code);
    done();
  });
  req.end();
}

{
  const server = https.createServer({ cert, key }, (_req, res) => res.end("ok"));
  const port = await listen(server);
  await new Promise<void>((done) =>
    report("omitted", https.request({ host: "localhost", port, path: "/", agent: false }), done),
  );
  await new Promise<void>((done) =>
    report("empty string", https.request({ host: "localhost", port, path: "/", agent: false, ca: "" }), done),
  );
  await new Promise<void>((done) =>
    report(
      "empty Buffer",
      https.request({ host: "localhost", port, path: "/", agent: false, ca: Buffer.alloc(0) }),
      done,
    ),
  );
  const options: unknown = { host: "localhost", port, path: "/", agent: false, ca: [] };
  await new Promise<void>((done) =>
    report("empty array in a runtime record", https.request(options as https.RequestOptions), done),
  );
  server.close();
}

{
  const server = http2.createSecureServer({ cert, key }, (_req, res) => res.end("ok"));
  const port = await listen(server);
  for (const [label, ca] of [["omitted", undefined], ["empty Buffer", Buffer.alloc(0)]] as const) {
    await new Promise<void>((done) => {
      const session = ca === undefined ? http2.connect(`https://localhost:${port}`) : http2.connect(`https://localhost:${port}`, { ca });
      session.on("connect", () => {
        console.log("http2.connect", label, "| connect");
        session.close();
      });
      session.on("error", (e: NodeJS.ErrnoException) => console.log("http2.connect", label, "| error", e.code));
      session.on("close", () => done());
    });
  }
  server.close();
}
