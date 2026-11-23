// On an allowHTTP1 server an HTTP/1.1 request has no backing HTTP/2
// stream: plain req.stream reads and presence tests see undefined (Node's
// value), a binding keeps it, and a default falls through, while consuming
// the absent stream throws JS's member TypeError. An HTTP/2 request sees
// the stream on every one of those reads.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import * as https from "node:https";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

function describe(req: http2.Http2ServerRequest, prefix: string): void {
  lines.push(`${prefix} presence ${req.stream ? "stream" : "none"}`);
  const bound = req.stream;
  lines.push(`${prefix} binding ${bound === undefined ? "undefined" : "stream"}`);
  const fallback: unknown = req.stream ?? "fallback";
  lines.push(`${prefix} nullish ${fallback === "fallback" ? "fallback" : "stream"}`);
}

await new Promise<void>((resolve) => {
  const server = http2.createSecureServer({ allowHTTP1: true, key, cert });
  server.on("request", (req, res) => {
    describe(req, "h1");
    try {
      const bound = req.stream;
      bound.respond({ ":status": 200 });
      lines.push("h1 consume no-throw");
    } catch (error) {
      const failure = error as Error;
      lines.push(`h1 consume ${failure.name}: ${failure.message}`);
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const request = https.request(
      {
        host: "127.0.0.1",
        servername: "localhost",
        port: (server.address() as AddressInfo).port,
        path: "/",
        method: "GET",
        ca,
        headers: { connection: "close" },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          server.close(() => resolve());
        });
      },
    );
    request.on("error", () => {
      server.close(() => resolve());
    });
    request.end();
  });
});

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("request", (req, res) => {
    describe(req, "h2");
    res.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/" });
    request.resume();
    request.on("end", () => {
      client.close(() => {
        server.close(() => resolve());
      });
    });
    request.end();
  });
});

for (const line of lines.sort()) console.log(line);
