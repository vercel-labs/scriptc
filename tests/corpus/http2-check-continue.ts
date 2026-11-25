// node:http2 Expect: 100-continue: without a 'checkContinue' listener the
// server answers 100 itself and emits 'request'; with one, that listener
// takes the request instead and answers with res.writeContinue(). The
// secure server routes it the same way.
import * as http2 from "node:http2";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

const body = (server: http2.Http2Server | http2.Http2SecureServer, label: string, secure: boolean) =>
  new Promise<void>((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      const client = secure
        ? http2.connect(`https://localhost:${port}`, { ca })
        : http2.connect(`http://127.0.0.1:${port}`);
      const request = client.request({ ":path": "/", ":method": "POST", expect: "100-continue" });
      request.on("continue", () => {
        lines.push(`${label} client continue`);
        request.end("body");
      });
      request.on("response", (headers) => lines.push(`${label} status ${headers[":status"]}`));
      request.on("data", (chunk) => lines.push(`${label} data ${String(chunk)}`));
      request.resume();
      request.on("end", () =>
        setTimeout(() => {
          client.close();
          server.close(() => resolve());
        }, 20),
      );
    });
  });

const plain = http2.createServer();
plain.on("request", (req, res) => {
  lines.push("plain request");
  res.end("plain");
});
const checked = http2.createServer();
checked.on("request", (req, res) => {
  lines.push("checked request");
  res.end("unexpected");
});
checked.on("checkContinue", (req, res) => {
  lines.push("checked checkContinue");
  res.writeContinue();
  res.end("checked");
});
const secure = http2.createSecureServer({ key, cert });
secure.on("request", (req, res) => {
  lines.push("secure request");
  res.end("unexpected");
});
secure.on("checkContinue", (req, res) => {
  lines.push("secure checkContinue");
  res.writeContinue();
  res.end("secure");
});

await body(plain, "plain", false);
await body(checked, "checked", false);
await body(secure, "secure", true);
for (const line of lines) console.log(line);
