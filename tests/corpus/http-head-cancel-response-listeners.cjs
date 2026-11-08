"use strict";
// A cancelled HEAD request that never ends: the response keeps the 'finish'
// listeners registered before the connection closed, and each 'close'
// listener captures the response, so the response and its listeners form a
// cycle. Node reclaims both once no JavaScript value reaches them; the
// listener release that runs during the cancellation must not leave an
// entry behind for the collector to walk.
const http = require("node:http");

const closed = [];
let finished = 0;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-length": "0" });
  response.flushHeaders();
  response.on("finish", () => {
    finished++;
  });
  for (let i = 0; i < 8; i++) {
    response.on("close", () => {
      closed.push(i + response.statusCode);
      if (closed.length === 8) {
        server.close(() => console.log("closed", closed.length, closed[0], finished));
      }
    });
  }
});

server.listen(0, () => {
  const port = server.address().port;
  const req = http.request({ port, method: "HEAD", path: "/" });
  req.on("error", () => {});
  req.on("response", (res) => {
    res.on("error", () => {});
    res.resume();
    req.destroy();
  });
  req.end();
});
