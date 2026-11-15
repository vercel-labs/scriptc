// server.listen's argument shapes, read the way net.Server.prototype.listen
// and its normalizeArgs read them: ([port][, host][, callback]) and
// (options[, callback]). An undefined port is an unused port, an undefined
// host is every interface (the address family Node binds without a host),
// and an undefined callback is no callback. Each case prints the family and
// address it bound, so listening on another family than Node shows.
import * as http from "node:http";
import * as net from "node:net";

const env = process.env;
const noHost: string | undefined = env.SCRIPTC_TEST_NO_SUCH_HOST;
const loopback: string | undefined = env.SCRIPTC_TEST_NO_SUCH_HOST ?? "127.0.0.1";
const noPort: number | undefined = env.SCRIPTC_TEST_NO_SUCH_PORT === undefined ? undefined : 1;
const somePort: number | undefined = env.SCRIPTC_TEST_NO_SUCH_PORT === undefined ? 0 : undefined;
env.SCRIPTC_TEST_PORT = "0";
// `process.env.PORT || 3000`: a string when set.
const envPort = env.SCRIPTC_TEST_PORT || 3000;
const defaultPort = env.SCRIPTC_TEST_NO_SUCH_PORT || 0;

type Listen = (server: net.Server, listening: () => void) => void;

const cases: [string, Listen][] = [
  ["listen()", (s, l) => { s.once("listening", l); s.listen(); }],
  ["listen(cb)", (s, l) => { s.listen(l); }],
  ["listen(0)", (s, l) => { s.once("listening", l); s.listen(0); }],
  ["listen(0, cb)", (s, l) => { s.listen(0, l); }],
  ["listen(undefined, cb)", (s, l) => { s.listen(undefined, l); }],
  ["listen(noPort, cb)", (s, l) => { s.listen(noPort, l); }],
  ["listen(somePort, cb)", (s, l) => { s.listen(somePort, l); }],
  ["listen(0, host)", (s, l) => { s.once("listening", l); s.listen(0, "127.0.0.1"); }],
  ["listen(0, host, cb)", (s, l) => { s.listen(0, "127.0.0.1", l); }],
  ["listen(0, '', cb)", (s, l) => { s.listen(0, "", l); }],
  ["listen(0, undefined, cb)", (s, l) => { s.listen(0, undefined, l); }],
  ["listen(0, noHost, cb)", (s, l) => { s.listen(0, noHost, l); }],
  ["listen(0, loopback, cb)", (s, l) => { s.listen(0, loopback, l); }],
  ["listen(0, noHost)", (s, l) => { s.once("listening", l); s.listen(0, noHost); }],
  ["listen(0, loopback)", (s, l) => { s.once("listening", l); s.listen(0, loopback); }],
  ["listen(noPort, noHost, cb)", (s, l) => { s.listen(noPort, noHost, l); }],
  ["listen(undefined, undefined, cb)", (s, l) => { s.listen(undefined, undefined, l); }],
  ["listen(0, undefined)", (s, l) => { s.once("listening", l); s.listen(0, undefined); }],
  ["listen(0, host, undefined)", (s, l) => { s.once("listening", l); s.listen(0, "127.0.0.1", undefined); }],
  ["listen(0, optional cb)", (s, l) => { const cb: (() => void) | undefined = noHost === undefined ? l : undefined; s.listen(0, cb); }],
  ["listen(0, host, optional cb)", (s, l) => { const cb: (() => void) | undefined = noHost === undefined ? l : undefined; s.listen(0, loopback, cb); }],
  ["listen(0, absent cb)", (s, l) => { const cb: (() => void) | undefined = noHost === undefined ? undefined : l; s.once("listening", l); s.listen(0, cb); }],
  ["listen(optional cb)", (s, l) => { const cb: (() => void) | undefined = noHost === undefined ? l : undefined; s.listen(cb); }],
  ["listen(absent cb)", (s, l) => { const cb: (() => void) | undefined = noHost === undefined ? undefined : l; s.once("listening", l); s.listen(cb); }],
  ["listen(envPort, cb)", (s, l) => { s.listen(envPort, l); }],
  ["listen(defaultPort, host, cb)", (s, l) => { s.listen(defaultPort, "127.0.0.1", l); }],
  ["listen({ port })", (s, l) => { s.once("listening", l); s.listen({ port: 0 }); }],
  ["listen({ port }, cb)", (s, l) => { s.listen({ port: 0 }, l); }],
  ["listen({ port, host }, cb)", (s, l) => { s.listen({ port: 0, host: "127.0.0.1" }, l); }],
  ["listen({ port, host: undefined }, cb)", (s, l) => { s.listen({ port: 0, host: undefined }, l); }],
  ["listen({ port, host: noHost }, cb)", (s, l) => { s.listen({ port: 0, host: noHost }, l); }],
  ["listen({ port, host: loopback }, cb)", (s, l) => { s.listen({ port: 0, host: loopback }, l); }],
  ["listen({ port: undefined }, cb)", (s, l) => { s.listen({ port: undefined }, l); }],
  ["listen({ port: noPort, host }, cb)", (s, l) => { s.listen({ port: noPort, host: "127.0.0.1" }, l); }],
];

function run(index: number): void {
  if (index === cases.length) {
    console.log("done");
    return;
  }
  const [name, listen] = cases[index]!;
  // Alternate the two server kinds: http.Server shares net.Server's listen.
  const server: net.Server =
    index % 2 === 0 ? net.createServer() : http.createServer((_req, res) => res.end());
  server.on("error", (err: Error) => {
    console.log(name, "error", err.message);
    run(index + 1);
  });
  listen(server, () => {
    const bound = server.address();
    console.log(name, bound.family, bound.address, bound.port > 0, server.listening);
    server.close(() => run(index + 1));
  });
}

run(0);
