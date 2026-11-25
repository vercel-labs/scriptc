// Expect: 100-continue on a dual-protocol (allowHTTP1) HTTP/2 server whose
// options are not a literal: the same 'checkContinue' listener must take
// HTTP/1.1 requests through the compat parser and HTTP/2 requests through
// the h2 dispatch, so 'request' never runs for a rejected request.
//
// A once listener is one registration mirrored into both parsers: the first
// protocol to answer consumes it, and the other must not stall — with no
// live listener left the server answers 100 itself and takes the request
// path, as Node does.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import * as https from "node:https";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

// Non-literal options: the compiler cannot fold allowHTTP1, so the runtime
// decides the protocol when the listener registers.
function secureOptions() {
  return { allowHTTP1: true, key, cert };
}

function listen(server: http2.Http2SecureServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function h1Request(port: number, expect: boolean, label: string): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { "content-type": "text/plain" };
    if (expect) headers.expect = "100-continue";
    const request = https.request(
      { host: "127.0.0.1", servername: "localhost", port, path: "/", method: "POST", ca, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          lines.push(`${label} h1 ${expect ? "expect" : "plain"} status ${response.statusCode} body ${body}`);
          resolve();
        });
      },
    );
    request.on("continue", () => lines.push(`${label} h1 continue`));
    request.on("error", (error) => {
      lines.push(`${label} h1 error ${String((error as NodeJS.ErrnoException).code)}`);
      resolve();
    });
    request.end("x");
  });
}

function h2Request(port: number, expect: boolean, label: string): Promise<void> {
  return new Promise((resolve) => {
    const client = http2.connect(`https://localhost:${port}`, { ca });
    const headers: http2.OutgoingHttpHeaders = { ":path": "/", ":method": "POST" };
    if (expect) headers.expect = "100-continue";
    const request = client.request(headers);
    let status = 0;
    let body = "";
    request.on("headers", (informational) => {
      lines.push(`${label} h2 headers ${String(informational[":status"])}`);
    });
    request.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"]);
    });
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      lines.push(`${label} h2 ${expect ? "expect" : "plain"} status ${status} body ${body}`);
      client.close(() => resolve());
    });
    request.end("x");
  });
}

let requestRuns = 0;
const server = http2.createSecureServer(secureOptions());
server.on("request", (req, res) => {
  requestRuns++;
  lines.push(
    `request ${req.httpVersion} ${req.headers.expect === undefined ? "no-expect" : String(req.headers.expect)}`,
  );
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("request body");
});
server.on("checkContinue", (req, res) => {
  lines.push(`checkContinue ${req.httpVersion} ${String(req.headers.expect)}`);
  res.writeHead(417, { "content-type": "text/plain" });
  res.end("rejected body");
});
const port = await listen(server);

await h1Request(port, true, "both");
await h1Request(port, false, "both");
await h2Request(port, true, "both");
await h2Request(port, false, "both");
lines.push(`request handler runs ${requestRuns}`);
await new Promise<void>((resolve) => server.close(() => resolve()));

let onceRuns = 0;
const onceServer = http2.createSecureServer(secureOptions());
onceServer.on("request", (req, res) => {
  onceRuns++;
  lines.push(`once request ${req.httpVersion} ${String(req.headers.expect)}`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("once request body");
});
onceServer.once("checkContinue", (req, res) => {
  lines.push(`once checkContinue ${req.httpVersion} ${String(req.headers.expect)}`);
  res.writeHead(417, { "content-type": "text/plain" });
  res.end("once rejected body");
});
const oncePort = await listen(onceServer);

await h1Request(oncePort, true, "once");
await h2Request(oncePort, true, "once");
lines.push(`once request handler runs ${onceRuns}`);
await new Promise<void>((resolve) => onceServer.close(() => resolve()));

for (const line of lines) console.log(line);
