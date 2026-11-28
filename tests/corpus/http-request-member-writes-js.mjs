import * as http from "node:http";

const server = http.createServer((req, res) => {
  req.method = "put";
  req.url = "/rewritten?x=1";
  req.headers = { host: "h" };
  req.headers["x-more"] = "m";
  res.end(JSON.stringify({ m: req.method, u: req.url, h: req.headers }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    let b = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (b += c));
    res.on("end", () => { console.log(b); server.close(); });
  });
});
