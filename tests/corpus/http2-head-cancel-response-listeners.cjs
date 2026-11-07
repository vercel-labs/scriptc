"use strict";
// Cancelling a HEAD request leaves its response with the 'finish' and
// 'close' listeners it registered: Node emits them from a later end(), so a
// cancelled response that never ends still holds them. A close listener that
// captures its response closes a cycle with it, and the response and its
// listeners must both be reclaimable while no JavaScript value reaches them.
const http2 = require("node:http2");

const closed = [];

const server = http2.createServer((request, response) => {
  response.writeHead(200);
  response.on("close", () => {
    closed.push(response.statusCode);
  });
});

server.listen(0, () => {
  const client = http2.connect(`http://localhost:${server.address().port}`);
  let pending = 24;
  for (let i = 0; i < 24; i++) {
    const stream = client.request({ ":method": "HEAD", ":path": "/" });
    stream.on("error", () => {});
    stream.on("response", () => stream.close(http2.constants.NGHTTP2_CANCEL));
    stream.on("close", () => {
      if (--pending === 0) {
        client.close();
        server.close(() => console.log("closed", closed.length));
      }
    });
  }
});
