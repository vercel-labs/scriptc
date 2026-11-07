// https.request(url, options[, callback]) — Node's three-argument URL form,
// against a localhost TLS server. The options' own members replace the
// URL's fields (path, method, headers), a port option overrides the URL's
// port, and the TLS knobs join from the same record: ca and servername
// verify a certificate for another name, rejectUnauthorized: false skips
// verification, and an Agent value dials the request.
import * as fs from "node:fs";
import * as tls from "node:tls";
import * as https from "node:https";

const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");
tls.setDefaultCACertificates([ca]);

const server = https.createServer(
  {
    key: fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem"),
    cert: fs.readFileSync("tests/fixtures/server/certs/localhost.pem"),
  },
  (req, res) => res.end(`${req.method} ${req.url} mode=${req.headers["x-mode"] ?? "-"}`),
);

function send(label: string, url: string, options: https.RequestOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = https.request(url, options, (res) => {
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

server.listen(0, () => {
  const port = (server.address() as { port: number }).port;
  const base = `https://localhost:${port}`;
  void (async () => {
    await send("override", `${base}/one`, {
      method: "POST",
      path: "/one-as-posted",
      headers: { "x-mode": "opts" },
    });
    await send("url-fields", `${base}/two?x=1`, { headers: { "x-mode": "url" } });
    await new Promise<void>((resolve) => {
      https.get(`${base}/three`, { headers: { "x-mode": "get" } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          console.log("get", res.statusCode, body);
          resolve();
        });
      });
    });
    await new Promise<void>((resolve) => {
      // a URL object target: its href through the same merge
      const req = https.request(new URL(`${base}/four`), { headers: { "x-mode": "obj" } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          console.log("url-object", res.statusCode, body);
          resolve();
        });
      });
      req.end();
    });
    const agent = new https.Agent({ keepAlive: false });
    await send("agent", `${base}/five`, { agent, headers: { "x-mode": "agent" } });
    // a port option replaces the URL's
    await send("port", `${base}/six`, { port: 1 });
    // the TLS options join from the merged record: servername names the
    // certificate to verify against, and rejectUnauthorized: false skips
    // the check
    await send("servername", `https://127.0.0.1:${port}/seven`, { ca, servername: "localhost" });
    await send("wrong-servername", `https://127.0.0.1:${port}/eight`, {
      ca,
      servername: "other.example",
    });
    await send("unverified", `https://127.0.0.1:${port}/nine`, { rejectUnauthorized: false });
    // a protocol option replaces the URL scheme the walk compares, like
    // Node's `{...urlToHttpOptions(url), ...options}` merge
    await send("scheme", `http://localhost:${port}/ten`, { protocol: "https:" });
    try {
      https.request(`${base}/eleven`, { protocol: "http:" }, () => {});
    } catch (err) {
      console.log("mismatch", (err as Error).message);
    }
    try {
      https.request("not a url", {}, () => {});
    } catch (err) {
      console.log("parse", (err as Error).message);
    }
    server.close();
  })();
});
