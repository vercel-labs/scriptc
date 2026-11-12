// https.Server inherits the request-limit dials from http.Server: the same
// defaults, the same read-back, and the same per-connection header cap over
// TLS (one line past the cap is the parser's 431 answer).
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

function get(port: number, extra: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < extra; i++) headers[`x-pad-${i}`] = "v";
    const req = https.request(
      { host: "127.0.0.1", port, path: "/", ca, headers, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          console.log("lines", extra + 1, "->", res.statusCode, res.headers.connection, JSON.stringify(body));
          resolve();
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log("lines", extra + 1, "error", err.code);
      resolve();
    });
    req.end();
  });
}

async function main(): Promise<void> {
  const plain = https.createServer({ cert, key }, () => {});
  console.log("default", plain.maxHeadersCount);
  plain.close();

  const server = https.createServer({ cert, key }, (req, res) => {
    res.end("ok:" + Object.keys(req.headers).length);
  });
  server.maxHeadersCount = 2;
  console.log("read", server.maxHeadersCount);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await get(port, 1);
  await get(port, 2);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

void main();
