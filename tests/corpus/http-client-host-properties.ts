import * as http from "node:http";

const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, path: "/x" }, (res) => {
    res.resume();
    res.on("end", () => {
      server.close();
    });
  });
  console.log("host", req.host, "protocol", req.protocol, "method", req.method, "path", req.path);
  req.setHeader("Host", "example.test:8080");
  console.log("after Host header", req.host, req.protocol);
  req.end();
});
