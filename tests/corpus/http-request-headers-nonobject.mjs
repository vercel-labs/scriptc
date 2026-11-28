import * as http from "node:http";

const server = http.createServer((req, res) => {
  const log = [];
  req.headers = 5;
  log.push(typeof req.headers, String(req.headers));
  try { req.headers["x"] = "1"; } catch (e) { log.push(`write threw ${e.name}`); }
  log.push(typeof req.headers, String(req.headers));
  req.headers = undefined;
  log.push(typeof req.headers, String(req.headers));
  req.headers = null;
  log.push(typeof req.headers, String(req.headers));
  res.end(JSON.stringify(log));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  http.get({ host: "127.0.0.1", port, path: "/", headers: { "x-a": "1" } }, (res) => {
    let b = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (b += c));
    res.on("end", () => { console.log(b); server.close(); });
  });
});
