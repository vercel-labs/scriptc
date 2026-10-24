// tls.Server's addContext and setSecureContext match Node: SNI names
// matched against exact and wildcard patterns (a "*" covers one label,
// case-insensitively, the newest match winning), the default context when
// nothing matches or an SNICallback is set, setSecureContext replacing the
// default context, the argument errors, the chain each context sends
// (completed from the default context's ca), and the store that verifies
// client certificates after each change.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), ca2 = r("ca2.pem"), cert = r("localhost.pem"), key = r("localhost-key.pem");
const alt = r("alt.pem"), altKey = r("alt-key.pem"), self = r("selfsigned.pem"), selfKey = r("selfsigned-key.pem");
const client = r("client.pem"), clientKey = r("client-key.pem");

const listen = (server: tls.Server): Promise<number> =>
  new Promise((d) => server.listen(0, () => d((server.address() as AddressInfo).port)));

function peer(port: number, servername: string): Promise<string> {
  return new Promise((res) => {
    const c = tls.connect({ port, servername, rejectUnauthorized: false }, () => {
      const p = c.getPeerCertificate();
      res(`${p.subject.CN}${p.subject.CN === "localhost" && p.issuer.CN === "localhost" ? "(self)" : ""}`);
      c.destroy();
    });
    c.on("error", (e: NodeJS.ErrnoException) => res(`error ${e.code}`));
  });
}

function chain(c: tls.TLSSocket): string {
  const names: string[] = [];
  let p: tls.DetailedPeerCertificate | undefined = c.getPeerCertificate(true);
  for (let i = 0; p !== undefined && i < 4; i++) {
    names.push(p.subject.CN as string);
    if (p.issuerCertificate === p) break;
    p = p.issuerCertificate;
  }
  return names.join(" -> ");
}

function look(port: number, servername: string): Promise<string> {
  return new Promise((res) => {
    const c = tls.connect({ port, servername, ca: ca2, rejectUnauthorized: false }, () => {
      const line = `${c.authorizationError} ${chain(c)}`;
      c.destroy();
      res(line);
    });
  });
}

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.message.split("\n")[0]);
  }
}

{
  const server = tls.createServer({ cert, key });
  server.addContext("alt.localhost", { cert: alt, key: altKey });
  server.addContext("*.wild.test", tls.createSecureContext({ cert: self, key: selfKey }));
  server.addContext("a.b.wild.test", { cert: alt, key: altKey });
  const port = await listen(server);
  const names = ["alt.localhost", "ALT.localhost", "x.wild.test", "a.b.wild.test", "c.b.wild.test", "wild.test", ".wild.test", "other", "alt.localhostx"];
  for (const name of names) console.log("sni", name, await peer(port, name));
  attempt("addContext empty", () => server.addContext("", { cert, key }));
  attempt("addContext string ctx", () => server.addContext("x.test", "nope" as unknown as tls.SecureContextOptions));
  server.addContext("alt.localhost", { cert: self, key: selfKey });
  console.log("override", await peer(port, "alt.localhost"));
  server.setSecureContext({ cert: alt, key: altKey });
  console.log("setSecureContext default", await peer(port, "nomatch"), await peer(port, "alt.localhost"));
  attempt("setSecureContext string", () => server.setSecureContext("x" as unknown as tls.SecureContextOptions));
  server.close();
}

{
  const server = tls.createServer({ cert, key, SNICallback: (n: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => cb(null, undefined) });
  server.addContext("alt.localhost", { cert: alt, key: altKey });
  console.log("with SNICallback", await peer(await listen(server), "alt.localhost"));
  server.close();
}

{
  const server = tls.createServer({ cert, key, ca });
  server.addContext("alt.localhost", { cert: alt, key: altKey });
  const port = await listen(server);
  console.log("server ca, sni", await look(port, "alt.localhost"));
  server.setSecureContext({ cert, key });
  console.log("after set without ca, sni", await look(port, "alt.localhost"));
  console.log("after set without ca, default", await look(port, "localhost"));
  server.close();
}

{
  const lines: string[] = [];
  const server = tls.createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: false }, (s) => {
    lines.push(`server ${s.authorized} ${s.authorizationError}`);
    s.end();
  });
  const port = await listen(server);
  const once = (servername: string): Promise<void> =>
    new Promise((res) => {
      const c = tls.connect({ port, servername, ca, cert: client, key: clientKey });
      c.on("data", () => {});
      c.on("close", () => res());
    });
  await once("localhost");
  server.setSecureContext({ cert, key, ca: ca2 });
  await once("localhost");
  server.addContext("alt.localhost", { cert: alt, key: altKey, ca });
  await once("alt.localhost");
  console.log(lines.join(" | "));
  server.close();
}
