// HTTP over a Unix domain socket: http.createServer().listen(path) and
// http.request / http.get with a socketPath option, from an object literal,
// from a RequestOptions variable, and from a literal that spreads one. The
// Host header defaults to localhost. A missing socket fails the request
// with ENOENT, a second listen on a bound path fails with EADDRINUSE, and
// closing the server removes the socket file.
import * as http from "node:http";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sock = join(tmpdir(), `scriptc-http-${process.pid}.sock`);
const shown = (text: string): string => text.split(sock).join("<sock>");

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    res.setHeader("content-type", "text/plain");
    res.end(`${req.method} ${req.url} host=${req.headers.host} x=${req.headers["x-n"]} body=${body}`);
  });
});

function collect(res: http.IncomingMessage, label: string, done: () => void): void {
  let text = "";
  res.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  res.on("end", () => {
    console.log(label, res.statusCode, res.headers["content-type"], text);
    done();
  });
}

function literal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request(
      { socketPath: sock, path: "/literal", method: "POST", headers: { "x-n": "1" } },
      (res) => collect(res, "literal", resolve),
    );
    req.end("one");
  });
}

const base: http.RequestOptions = { socketPath: sock };

function fromVariable(): Promise<void> {
  return new Promise<void>((resolve) => {
    const headers: Record<string, string | number> = { "x-n": 2, "content-type": "text/plain" };
    const options: http.RequestOptions = { ...base, path: "/variable", method: "PUT", headers, timeout: 5000 };
    const req = http.request(options, (res) => collect(res, "variable", resolve));
    req.write("two");
    req.end();
  });
}

function spread(): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request({ ...base, path: "/spread", method: "POST", headers: { "x-n": "3" } }, (res) =>
      collect(res, "spread", resolve),
    );
    req.end("three");
  });
}

function get(): Promise<void> {
  return new Promise<void>((resolve) => {
    const options: http.RequestOptions = { socketPath: sock, path: "/get?q=4" };
    http.get(options, (res) => collect(res, "get", resolve));
  });
}

function missing(): Promise<void> {
  return new Promise<void>((resolve) => {
    const options: http.RequestOptions = { socketPath: `${sock}.missing`, path: "/" };
    const req = http.request(options, () => console.log("unexpected response"));
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log("missing", err.code, shown(err.message));
      resolve();
    });
    req.end();
  });
}

function busy(): Promise<void> {
  return new Promise<void>((resolve) => {
    const other = http.createServer();
    other.on("error", (err: NodeJS.ErrnoException) => {
      console.log("busy", err.code, shown(err.message));
      resolve();
    });
    other.listen(sock);
  });
}

server.listen(sock, async () => {
  console.log("listening", existsSync(sock));
  await literal();
  await fromVariable();
  await spread();
  await get();
  await missing();
  await busy();
  server.close(() => {
    console.log("closed", existsSync(sock));
  });
});
