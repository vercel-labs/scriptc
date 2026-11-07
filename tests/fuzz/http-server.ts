// The HTTP/1 server under test: answers every request with what it parsed. A raw-socket client sends it damaged
// requests (scripts/fuzz-http.mjs).
//
// It prints "listening <port>". With `log` it also prints one line when a request reaches the handler and one
// when its body ends, each with the client's port, which is how the framing differential compares two servers.
import { createServer } from "node:http";

export function serve(port: number, log: boolean): void {
  const server = createServer((req, res) => {
    const from = req.socket.remotePort ?? 0;
    if (log) {
      console.log(
        JSON.stringify({ from, method: req.method, url: req.url, version: req.httpVersion, headers: req.rawHeaders.length }),
      );
    }
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (log) console.log(JSON.stringify({ from, url: req.url, body: n, trailers: req.rawTrailers.length }));
      res.setHeader("x-n", String(n));
      res.setHeader("x-h", String(Object.keys(req.headers).length));
      if (req.url !== undefined && req.url.length % 3 === 0) res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ m: req.method, u: req.url, v: req.httpVersion, h: req.rawHeaders.length, t: req.rawTrailers.length, n }),
      );
    });
  });
  server.on("clientError", (err, socket) => {
    socket.destroy();
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log("listening", address !== null && typeof address === "object" ? address.port : 0);
  });
}
