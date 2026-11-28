import * as http from "node:http";
const server = http.createServer((req, res) => {
  const log = [];
  req.headers["x-a"] = "9";
  req.headers["x-new"] = "n";
  log.push(req.headers["x-a"], req.headers["x-new"]);
  req.headers = undefined;
  log.push(typeof req.headers, req.headers["x-a"], req.headers["x-new"]);
  req.headers["x-a"] = "8";
  req.headers = null;
  log.push(typeof req.headers, req.headers["x-a"], req.headers["x-new"]);
  res.end(JSON.stringify(log));
});
server.listen(0, "127.0.0.1", () => {
  const a = server.address();
  const port = typeof a === "object" && a !== null ? a.port : 0;
  http.get({ host: "127.0.0.1", port, path: "/", headers: { "x-a": "1" } }, (res) => {
    let b = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (b += c));
    res.on("end", () => { console.log(b); server.close(); });
  });
});
