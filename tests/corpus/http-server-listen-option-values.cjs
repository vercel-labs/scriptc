// server.listen()'s options object read as JavaScript values: a string port
// is a port (validatePort), while a port of any other kind leaves the TCP
// branch and lets a pipe path bind (the port is ignored); the host is only
// checked once the TCP branch wins. The path values that are not pipe names
// and the non-string host report Node's errors with the inspected object.
'use strict';
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-listen-values-"));
const boolSock = path.join(dir, "bool.sock");
const hostSock = path.join(dir, "host.sock");
const shown = (text) => text.split(dir).join("<dir>");

// Each object literal stays at a listen call site on a server read from
// createServer (the keys' inferred types are what the lowering reads).
function showError(label, run) {
  try {
    run();
  } catch (e) {
    console.log(label, e.name, e.code, shown(e.message));
  }
}

showError("string port", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: "abc" });
});
showError("blank port", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: " " });
});
showError("big string port", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: "70000" });
});
showError("boolean port", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: true });
});
showError("boolean port and number path", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: true, path: 12 });
});
showError("numeric path", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ path: 12 });
});
showError("null path", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ path: null });
});
showError("number host", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: 0, host: 5 });
});
showError("boolean host", () => {
  const server = http.createServer((req, res) => res.end("x"));
  server.listen({ port: 0, host: false });
  console.log("boolean host no throw");
  server.close();
});

function stringPort() {
  const server = http.createServer((req, res) => res.end(`string ${req.url}`));
  server.listen({ port: "0", host: "127.0.0.1" }, () => {
    const address = server.address();
    console.log("string port listening", address.address, address.port > 0);
    server.close(() => boolPort());
  });
}

function boolPort() {
  const server = http.createServer((req, res) => res.end(`bool ${req.url}`));
  server.listen({ port: true, path: boolSock }, () => {
    console.log("bool port listening", server.listening, fs.existsSync(boolSock));
    http
      .get({ socketPath: boolSock, path: "/bool" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => console.log("response", chunk));
        res.on("end", () => server.close(() => numberHost()));
      })
      .on("error", (error) => console.log("client error", error.message));
  });
}

function numberHost() {
  const server = http.createServer((req, res) => res.end(`host ${req.url}`));
  server.listen({ path: hostSock, host: 5 }, () => {
    console.log("number host listening", server.listening, fs.existsSync(hostSock));
    http
      .get({ socketPath: hostSock, path: "/host" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => console.log("response", chunk));
        res.on("end", () => {
          server.close(() => {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log("done");
          });
        });
      })
      .on("error", (error) => console.log("client error", error.message));
  });
}

stringPort();
