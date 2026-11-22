// The message state flags across a request's life: destroyed, headersSent,
// finished, writableEnded and writableFinished at each step.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
    console.log("res early", res.destroyed, res.complete);
    res.resume();
    res.on("end", () => {
      console.log("res end", res.destroyed, res.complete);
      server.close();
    });
  });
  console.log("before end", req.destroyed, req.headersSent, req.finished, req.writableEnded, req.writableFinished);
  req.end("body");
  console.log("after end", req.destroyed, req.headersSent, req.finished, req.writableEnded, req.writableFinished);
  req.on("finish", () => {
    console.log("finish", req.destroyed, req.finished, req.writableFinished);
  });
});
