// A request options object takes its `headers` by shorthand (the Record
// value itself, flattened like the literal form) and a `protocol` string
// that Node compares against the module's scheme: a match sends, a
// mismatch throws ERR_INVALID_PROTOCOL.
import * as http from "node:http";
import * as https from "node:https";
import { readFileSync } from "node:fs";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const plain = http.createServer((req, res) =>
  res.end(`${req.method} ${req.url} mode=${req.headers["x-mode"] ?? "-"}`),
);
const secure = https.createServer({ key, cert }, (req, res) =>
  res.end(`tls ${req.method} ${req.url} mode=${req.headers["x-mode"] ?? "-"}`),
);

const headers: Record<string, string> = { "x-mode": "shorthand" };

function sendPlain(label: string, options: http.RequestOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        console.log(label, res.statusCode, body);
        resolve();
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log(label, "error", err.code);
      resolve();
    });
    req.end();
  });
}

plain.listen(0, "127.0.0.1", () => {
  const port = (plain.address() as { port: number }).port;
  secure.listen(0, "127.0.0.1", () => {
    const sport = (secure.address() as { port: number }).port;
    void (async () => {
      await sendPlain("plain", { hostname: "127.0.0.1", port, path: "/a", headers, protocol: "http:" });
      await new Promise<void>((resolve) => {
        const req = https.request(
          { hostname: "localhost", port: sport, path: "/b", headers, ca, protocol: "https:" },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString()));
            res.on("end", () => {
              console.log("secure", res.statusCode, body);
              resolve();
            });
          },
        );
        req.on("error", (err: NodeJS.ErrnoException) => {
          console.log("secure", "error", err.code);
          resolve();
        });
        req.end();
      });
      try {
        https.request({ hostname: "localhost", port: sport, path: "/c", protocol: "http:" }, () => {});
      } catch (err) {
        console.log("secure-mismatch", (err as Error).message);
      }
      try {
        http.request({ hostname: "127.0.0.1", port, path: "/d", protocol: "https:" }, () => {});
      } catch (err) {
        console.log("plain-mismatch", (err as Error).message);
      }
      plain.close();
      secure.close();
    })();
  });
});
