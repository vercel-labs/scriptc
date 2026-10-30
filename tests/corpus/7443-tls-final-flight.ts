// The last handshake flight is flushed when Node flushes it: after the
// callbacks that see the handshake finish and their nextTick callbacks,
// before the immediates they queue. A destroy() in secureConnect or a tick
// drops a TLS 1.3 client's Finished (the server reports a hang-up), one in
// secureConnection drops a TLS 1.2 server's Finished (the client ends, then
// fails), and data written beside it is dropped too; end() and a destroy
// in an immediate let it go out. A client whose server closes or resets
// mid-handshake gets Node's events, from tls.connect and https.request.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/localhost.pem`), key = readFileSync(`${D}/localhost-key.pem`);
type Version = "TLSv1.2" | "TLSv1.3";
const hows = ["destroy", "tick", "immediate", "write+destroy", "end"];

function act(s: tls.TLSSocket, how: string): void {
  if (how === "destroy") s.destroy();
  else if (how === "tick") process.nextTick(() => s.destroy());
  else if (how === "immediate") setImmediate(() => s.destroy());
  else if (how === "write+destroy") {
    s.write("hi");
    s.destroy();
  } else s.end("bye");
}

const listen = (server: net.Server): Promise<number> =>
  new Promise((d) => server.listen(0, "127.0.0.1", () => d((server.address() as AddressInfo).port)));

// the client acts in secureConnect; the server reports what arrived
for (const v of ["TLSv1.2", "TLSv1.3"] as Version[]) {
  for (const how of hows) {
    const ev: string[] = [];
    const server = tls.createServer({ cert, key, maxVersion: v }, (s) => {
      ev.push("secureConnection");
      s.on("data", (d: Buffer) => ev.push(`data ${d}`));
      // A client that closes before it reads the server's TLS 1.3 session
      // tickets resets the connection. Whether the tickets are read first
      // depends on the platform's timing, so that reset is not printed.
      s.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "ECONNRESET") ev.push(`server socket error ${e.code}`);
      });
    });
    server.on("tlsClientError", (e: Error) => ev.push(`tlsClientError ${(e as NodeJS.ErrnoException).code}`));
    const port = await listen(server);
    await new Promise<void>((res) => {
      const c = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => act(c, how));
      c.on("close", () => setTimeout(res, 100));
    });
    console.log("client", v, how, "|", ev.join(" ; "));
    server.close();
  }
}

// the server acts in secureConnection; the client reports what arrived
for (const v of ["TLSv1.2", "TLSv1.3"] as Version[]) {
  for (const how of hows) {
    const ev: string[] = [];
    const server = tls.createServer({ cert, key, maxVersion: v }, (s) => {
      s.on("error", () => {});
      act(s, how);
    });
    const port = await listen(server);
    await new Promise<void>((res) => {
      const c = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false }, () => ev.push("secureConnect"));
      c.on("data", (d: Buffer) => ev.push(`data ${d}`));
      c.on("end", () => ev.push("end"));
      c.on("error", (e: NodeJS.ErrnoException) => ev.push(`error ${e.code} ${e.message}`));
      c.on("close", (hadError: boolean) => {
        ev.push(`close ${hadError}`);
        setTimeout(res, 50);
      });
    });
    console.log("server", v, how, "|", ev.join(" ; "));
    server.close();
  }
}

// a peer that closes or resets after the client's hello
for (const how of ["fin", "rst"]) {
  for (const via of ["tls.connect", "https.request"]) {
    const ev: string[] = [];
    const server = net.createServer((s) => {
      s.once("data", () => {
        if (how === "rst") s.resetAndDestroy();
        else s.end();
      });
    });
    const port = await listen(server);
    await new Promise<void>((res) => {
      if (via === "tls.connect") {
        const c = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false });
        c.on("end", () => ev.push("end"));
        c.on("error", (e: NodeJS.ErrnoException) => ev.push(`error ${e.code} ${e.message}`));
        c.on("close", (hadError: boolean) => {
          ev.push(`close ${hadError}`);
          res();
        });
      } else {
        const req = https.request({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false, agent: false });
        req.on("error", (e: NodeJS.ErrnoException) => {
          ev.push(`request error ${e.code} ${e.message}`);
          res();
        });
        req.end();
      }
    });
    console.log("peer", how, via, "|", ev.join(" ; "));
    server.close();
  }
}
