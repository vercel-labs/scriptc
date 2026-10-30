// The completion callback of a callback-style API runs with the
// AsyncLocalStorage stores that were active when the call started the
// operation, as in Node.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as dgram from "node:dgram";
import * as dns from "node:dns";
import { readFile, rename, writeFileSync, unlinkSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

const store = new AsyncLocalStorage<string>();

// Starts one operation inside run(name) and waits for its callback.
function step(name: string, start: (done: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    store.run(name, () =>
      start(() => {
        console.log(name, store.getStore());
        resolve();
      }),
    );
  });
}

const dir = tmpdir();
const file = join(dir, `scriptc-als-${process.pid}.txt`);
writeFileSync(file, "hello");

await step("fs.readFile", (done) => readFile(file, "utf8", () => done()));
await step("fs.rename", (done) => rename(file, `${file}.moved`, () => done()));
unlinkSync(`${file}.moved`);

await step("crypto.randomBytes", (done) => crypto.randomBytes(4, () => done()));
await step("crypto.randomInt", (done) => crypto.randomInt(10, () => done()));
await step("crypto.randomFill", (done) => crypto.randomFill(new Uint8Array(4), () => done()));
await step("crypto.pbkdf2", (done) => crypto.pbkdf2("p", "s", 1, 8, "sha256", () => done()));
await step("crypto.scrypt", (done) => crypto.scrypt("p", "s", 8, () => done()));
await step("crypto.hkdf", (done) => crypto.hkdf("sha256", "k", "s", "i", 8, () => done()));
await step("crypto.generateKey", (done) =>
  crypto.generateKey("hmac", { length: 64 }, () => done()),
);

await step("zlib.gzip", (done) => zlib.gzip(Buffer.from("hello"), () => done()));
await step("zlib.deflate options", (done) =>
  zlib.deflate(Buffer.from("hello"), { level: 1 }, () => done()),
);

await step("dns.lookup", (done) => dns.lookup("localhost", () => done()));
await step("child_process.execFile", (done) => execFile("true", [], () => done()));

// A server's listen callback, a client connection and an HTTP response
// each run in the stores of their own call.
const server = net.createServer((socket) => socket.end());
await step("net listen", (done) => server.listen(0, "127.0.0.1", () => done()));
const port = (server.address() as net.AddressInfo).port;
await step("net.connect", (done) => {
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.destroy();
    done();
  });
});
server.close();

const web = http.createServer((_req, res) => res.end("ok"));
await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", () => resolve()));
const webPort = (web.address() as net.AddressInfo).port;
await step("http.get", (done) =>
  http.get(`http://127.0.0.1:${webPort}/`, (res) => {
    res.resume();
    done();
  }),
);
await step("http.request", (done) =>
  http
    .request({ host: "127.0.0.1", port: webPort, path: "/", method: "GET" }, (res) => {
      res.resume();
      done();
    })
    .end(),
);
web.close();

const optionsServer = net.createServer();
await step("net listen options", (done) =>
  optionsServer.listen({ port: 0, host: "127.0.0.1" }, () => done()),
);
optionsServer.close();
const pathServer = net.createServer();
const socketPath = join(dir, `scriptc-als-${process.pid}.sock`);
await step("net listen path", (done) => pathServer.listen(socketPath, () => done()));
pathServer.close();

const udp = dgram.createSocket("udp4");
await step("dgram bind", (done) => udp.bind(0, "127.0.0.1", () => done()));
const peer = dgram.createSocket("udp4");
await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", () => resolve()));
await step("dgram connect", (done) => udp.connect(peer.address().port, "127.0.0.1", () => done()));
peer.close();
await step("dgram close", (done) => udp.close(() => done()));

await step("process.stdout.write", (done) => process.stdout.write("", () => done()));

// Nested: a callback starts another operation in a different store.
await step("outer", (done) =>
  crypto.randomBytes(1, () => {
    console.log("outer callback", store.getStore());
    store.run("inner", () =>
      crypto.randomBytes(1, () => {
        console.log("inner callback", store.getStore());
        done();
      }),
    );
  }),
);

// A callback whose call ran with no store sees no store, and a store the
// callback enters does not reach the next callback.
await new Promise<void>((resolve) =>
  crypto.randomBytes(1, () => {
    console.log("no store", store.getStore());
    store.enterWith("entered");
    resolve();
  }),
);
await new Promise<void>((resolve) =>
  crypto.randomBytes(1, () => {
    console.log("after enterWith", store.getStore());
    resolve();
  }),
);
