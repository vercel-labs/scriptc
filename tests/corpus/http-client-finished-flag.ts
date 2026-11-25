// A request's `finished` is Node's deprecated alias of `writableEnded`: false
// before end(), true once the body has gone out, at every point the pair is
// read.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => res.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("settled", req.finished, req.writableEnded);
      server.close();
    });
  });
  console.log("before", req.finished, req.writableEnded);
  req.end("body");
  console.log("after end()", req.finished, req.writableEnded, req.writableFinished);
});
