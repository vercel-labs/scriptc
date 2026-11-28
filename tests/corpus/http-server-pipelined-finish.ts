// A pipelined client that never reads: the server parses every request, and a
// response 'finish' fires as the socket takes that response's own bytes — not
// only once the whole connection buffer has drained (Node finishes some of
// them while the rest wait).
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

let parsed = 0;
let finished = 0;
const server = http.createServer((req, res) => {
  parsed += 1;
  res.on("finish", () => {
    finished += 1;
  });
  res.end("x".repeat(16 * 1024) + req.url);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const sock = net.connect(port, "127.0.0.1");
  sock.on("connect", () => {
    let all = "";
    for (let i = 0; i < 2000; i++) all += "GET /" + i + " HTTP/1.1\r\nHost: x\r\n\r\n";
    sock.write(all);
  });
  sock.on("error", () => {});
  setTimeout(() => {
    console.log("parsed", parsed, "some finished", finished > 0, "all finished", finished === parsed);
    sock.destroy();
    server.close();
  }, 500);
});
