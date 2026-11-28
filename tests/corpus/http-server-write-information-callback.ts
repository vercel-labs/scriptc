// writeInformation and writeEarlyHints callbacks fire once the informational
// response is written, before the final response.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  res.writeInformation(102, { "x-a": "1" }, () => console.log("info callback"));
  res.writeEarlyHints({ link: "</x.css>; rel=preload" }, () => console.log("hints callback"));
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ port, host: "127.0.0.1", path: "/" }, (res) => {
    let body = "";
    res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    res.on("end", () => { console.log("response", res.statusCode, body); server.close(); });
  });
  req.on("information", (info) => console.log("information", info.statusCode, JSON.stringify(info.headers)));
  req.end();
});
