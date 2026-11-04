// http.request(url, options[, callback]) — the plain-scheme URL form
// against a localhost server: the options' path, method, and headers
// replace the URL's fields, a port option overrides the URL's port, and a
// protocol option replaces the URL's scheme in the merge, while a scheme
// the calling module does not speak throws Node's ERR_INVALID_PROTOCOL.
import * as http from "node:http";

const server = http.createServer((req, res) =>
  res.end(`${req.method} ${req.url} mode=${req.headers["x-mode"] ?? "-"}`),
);

function send(label: string, url: string, options: http.RequestOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request(url, options, (res) => {
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

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  void (async () => {
    await send("override", `${base}/one`, {
      method: "PUT",
      path: "/one-as-put",
      headers: { "x-mode": "opts" },
    });
    await send("url-fields", `${base}/two?x=1`, { headers: { "x-mode": "url" } });
    await new Promise<void>((resolve) => {
      http.get(`${base}/three`, { headers: { "x-mode": "get" } }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => {
          console.log("get", res.statusCode, body);
          resolve();
        });
      });
    });
    // a matching protocol option keeps the module's scheme
    await send("scheme", `${base}/four`, { protocol: "http:" });
    // a port option replaces the URL's
    await send("port", `${base}/five`, { port: 1 });
    try {
      http.request(`${base}/six`, { protocol: "https:" }, () => {});
    } catch (err) {
      console.log("mismatch", (err as Error).message);
    }
    try {
      http.request(`https://127.0.0.1:${port}/seven`, {}, () => {});
    } catch (err) {
      console.log("scheme-check", (err as Error).message);
    }
    try {
      http.request("not a url", {}, () => {});
    } catch (err) {
      console.log("parse", (err as Error).message);
    }
    server.close();
  })();
});
