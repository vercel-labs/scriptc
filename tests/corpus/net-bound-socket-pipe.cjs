// net.BoundSocket with { path }: a Unix-domain socket bound before any
// server adopts it. The path exists once bound, address() answers it, and
// close()/[Symbol.dispose]() remove it; a server that adopts the handle
// through listen(bound) or listen({ handle: bound }) answers the same path
// and unlinks it at close. The bind errors name the libuv codes: EADDRINUSE
// for a taken path or a directory, EACCES for a missing parent, EINVAL for
// an embedded NUL. Output masks the temporary directory so the two runs
// compare.
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspect } = require("node:util");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-bound-pipe-"));
const socketPath = path.join(dir, "server.sock");
const mask = (text) => text.split(dir).join("<dir>");

function attempt(label, fn) {
  try {
    const value = fn();
    console.log(label, "ok", typeof value);
  } catch (err) {
    console.log(label, "threw", err.name, err.code, mask(err.message));
  }
}

const bound = new net.BoundSocket({ path: socketPath });
console.log("bound", bound.address() === socketPath, bound.isPipe, bound.fd() > 0);
console.log("json", JSON.stringify(bound), inspect(bound), bound instanceof net.BoundSocket);
console.log("exists", fs.existsSync(socketPath));

attempt("duplicate", () => new net.BoundSocket({ path: socketPath }));
attempt("missing parent", () => new net.BoundSocket({ path: path.join(dir, "missing", "x.sock") }));
attempt("directory", () => new net.BoundSocket({ path: dir }));
attempt("nul", () => new net.BoundSocket({ path: "a\u0000b" }));
attempt("exclusive", () => new net.BoundSocket({ path: socketPath, port: 0 }));
attempt("exclusive null", () => new net.BoundSocket({ path: socketPath, reusePort: null }));
// A long directory pushes the Received tail past util.inspect's break
// length, so the message lays its properties out one per line.
const longDir = path.join(dir, "d".repeat(40));
fs.mkdirSync(longDir, { recursive: true });
attempt("exclusive long", () => new net.BoundSocket({ path: path.join(longDir, "server.sock"), port: 0 }));
attempt("null path", () => new net.BoundSocket({ path: null }));
attempt("long path", () => new net.BoundSocket({ path: path.join(dir, "x".repeat(120)) }));
attempt("empty path", () => {
  const unnamed = new net.BoundSocket({ path: "" });
  const shown = unnamed.address();
  unnamed.close();
  return shown === "";
});
attempt("undefined path", () => {
  const tcp = new net.BoundSocket({ path: undefined });
  const shown = tcp.address();
  tcp.close();
  return shown.family === "IPv4" && shown.address === "0.0.0.0";
});

const closedPath = path.join(dir, "closed.sock");
const closing = new net.BoundSocket({ path: closedPath });
console.log("closing", fs.existsSync(closedPath));
closing.close();
console.log("closing unlinked", fs.existsSync(closedPath));
attempt("closed address", () => closing.address());

// Abstract (name-less) socket paths are a Linux feature: elsewhere the bind
// is refused by Node, so the section only runs where it exists.
if (process.platform === "linux") {
  const abstractPath = "\u0000scriptc-bound-" + process.pid;
  const abstractBound = new net.BoundSocket({ path: abstractPath });
  console.log("abstract", abstractBound.address() === abstractPath, abstractBound.isPipe, fs.existsSync(abstractPath));
  attempt("abstract duplicate", () => new net.BoundSocket({ path: abstractPath }));
  abstractBound.close();
  attempt("abstract reused", () => {
    const again = new net.BoundSocket({ path: abstractPath });
    const shown = again.address();
    again.close();
    return shown === abstractPath;
  });
}

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => socket.write(`echo:${chunk}`));
});
server.on("error", (err) => console.log("server error", err.code, mask(err.message)));
server.listen(bound, () => {
  // The path is the server's endpoint (a pipe server's address() answers
  // it; the corpus reads it through the filesystem as the unix-socket
  // programs do, since the typed surface hands address() back as the
  // AddressInfo record).
  console.log("adopted", fs.existsSync(socketPath), bound.isPipe, server.listening);
  attempt("adopted address", () => bound.address());
  attempt("adopted fd", () => bound.fd());
  console.log("dispose", bound[Symbol.dispose]());
  const client = net.createConnection(socketPath);
  client.on("connect", () => client.write("ping"));
  client.on("data", (chunk) => {
    console.log("echo", chunk.toString());
    client.end();
  });
  client.on("close", () => {
    server.close(() => {
      console.log("unlinked", fs.existsSync(socketPath));
      const viaHandle = new net.BoundSocket({ path: socketPath });
      const second = net.createServer();
      second.on("error", (err) => console.log("second error", err.code, mask(err.message)));
      second.listen({ handle: viaHandle }, () => {
        console.log("handle form", fs.existsSync(socketPath), second.listening);
        second.close(() => {
          console.log("unlinked again", fs.existsSync(socketPath));
          fs.rmSync(dir, { recursive: true, force: true });
          console.log("done");
        });
      });
    });
  });
});
