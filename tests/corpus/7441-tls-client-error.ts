// tls.Server's 'tlsClientError' event matches Node: the error a failed
// handshake reports (OpenSSL's codes and messages for an HTTP or proxy
// request, a client that rejects the certificate, a missing required
// certificate, an unsupported version and no common ALPN protocol; a
// "socket hang up" ECONNRESET for a client that leaves), the socket it
// passes, what the client sees, and the same event on https.Server.
import * as https from "node:https";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const r = (f: string): Buffer => readFileSync(`${D}/${f}`);
const ca = r("ca.pem"), ca2 = r("ca2.pem"), cert = r("localhost.pem"), key = r("localhost-key.pem");
const clean = (m: string): string => m.replace(/^[0-9A-F]+:/, "").split(":../")[0]!;

type Drive = (port: number, client: string[], fin: () => void) => void;

async function scenario(label: string, make: (h: (s: tls.TLSSocket) => void) => tls.Server, drive: Drive): Promise<void> {
  await new Promise<void>((done) => {
    const events: string[] = [];
    const client: string[] = [];
    const server = make((s) => {
      events.push("secureConnection");
      s.end("ok");
    });
    server.on("tlsClientError", (err: Error, socket: tls.TLSSocket) => {
      events.push(`tlsClientError ${err.name} ${(err as NodeJS.ErrnoException).code} [${clean(err.message)}] destroyed=${socket.destroyed} remote=${typeof socket.remoteAddress}`);
      socket.on("close", () => events.push("server socket close"));
    });
    server.listen(0, () => {
      drive((server.address() as AddressInfo).port, client, () =>
        setTimeout(() => {
          console.log(label, "|", events.join(" ; "), "| client:", client.join(" ; "));
          server.close(() => done());
        }, 100),
      );
    });
  });
}

const raw = (bytes: Buffer | null, endFirst: boolean): Drive => (port, client, fin) => {
  const s = net.connect(port, "127.0.0.1", () => {
    if (bytes !== null) s.write(bytes);
    if (endFirst) s.end();
  });
  s.on("data", (d: Buffer) => client.push(`data ${d.length}`));
  s.on("end", () => client.push("end"));
  s.on("error", (e: NodeJS.ErrnoException) => client.push(`error ${e.code}`));
  s.on("close", (hadError: boolean) => {
    client.push(`close ${hadError}`);
    fin();
  });
};

const tlsc = (trust: Buffer, maxVersion: "TLSv1.2" | "TLSv1.3", alpn: boolean): Drive => (port, client, fin) => {
  const c = alpn
    ? tls.connect({ port, servername: "localhost", ca: trust, maxVersion, ALPNProtocols: ["http/1.1"] })
    : tls.connect({ port, servername: "localhost", ca: trust, maxVersion });
  c.on("secureConnect", () => client.push("secureConnect"));
  c.on("error", (e: NodeJS.ErrnoException) => client.push(`error ${e.code}`));
  c.on("data", () => {});
  c.on("close", (hadError: boolean) => {
    client.push(`close ${hadError}`);
    fin();
  });
};

const plain = (h: (s: tls.TLSSocket) => void): tls.Server => tls.createServer({ cert, key }, h);
await scenario("close before hello", plain, raw(null, true));
await scenario("http request", plain, raw(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), false));
await scenario("connect request", plain, raw(Buffer.from("CONNECT x:443 HTTP/1.1\r\n\r\n"), false));
await scenario("half hello", plain, raw(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01]), true));
await scenario("client rejects cert", plain, tlsc(ca2, "TLSv1.3", false));
await scenario("no cert, required", (h) => tls.createServer({ cert, key, requestCert: true, ca }, h), tlsc(ca, "TLSv1.3", false));
await scenario("version", (h) => tls.createServer({ cert, key, minVersion: "TLSv1.3" }, h), tlsc(ca, "TLSv1.2", false));
await scenario("alpn", (h) => tls.createServer({ cert, key, ALPNProtocols: ["h2"] }, h), tlsc(ca, "TLSv1.3", true));
await scenario("ok", plain, tlsc(ca, "TLSv1.3", false));

{
  const server = https.createServer({ cert, key }, (req, res) => res.end("ok"));
  server.on("tlsClientError", (err: Error, socket: tls.TLSSocket) => console.log("https tlsClientError", (err as NodeJS.ErrnoException).code, socket.destroyed));
  await new Promise<void>((d) => server.listen(0, () => d()));
  await new Promise<void>((res) => {
    const s = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => s.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    s.on("data", () => {});
    s.on("error", (e: NodeJS.ErrnoException) => console.log("https client error", e.code));
    s.on("close", () => res());
  });
  await new Promise<void>((d) => setTimeout(d, 50));
  server.close();
}
