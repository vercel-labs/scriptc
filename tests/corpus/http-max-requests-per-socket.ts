// server.maxRequestsPerSocket bounds the requests one connection serves:
// the request that reaches the cap still runs and its head says
// Connection: close while the socket stays open, and every request after it
// fires 'dropRequest' with (request, socket) and is answered 503.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.url);
  res.end("hello " + req.url);
});
server.maxRequestsPerSocket = 2;

server.on("dropRequest", (req: http.IncomingMessage, socket: net.Socket): void => {
  console.log("dropRequest", req.url, req.method, "destroyed", socket.destroyed);
});
server.once("dropRequest", (req: http.IncomingMessage): void => {
  console.log("once", req.url);
});
const spare = (req: http.IncomingMessage): void => {
  console.log("spare", req.url);
};
server.on("dropRequest", spare);
console.log("listeners", server.listeners("dropRequest").length);
server.off("dropRequest", spare);
console.log("listeners", server.listeners("dropRequest").length);

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const conn = net.createConnection(port, "127.0.0.1", () => {
    let all = "";
    for (let i = 1; i <= 4; i++) all += `GET /r${i} HTTP/1.1\r\nHost: example.com\r\n\r\n`;
    conn.write(all);
  });
  let text = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk: string) => {
    text += chunk;
    if (text.split("HTTP/1.1 ").length - 1 < 4) return;
    conn.destroy();
    for (const part of text.split(/(?=HTTP\/1\.1 )/)) {
      const head = part.split("\r\n\r\n")[0]!;
      console.log(head.split("\r\n").filter((line) => !line.startsWith("Date: ")).join("|"));
    }
    server.close();
  });
  conn.on("error", () => {});
});
