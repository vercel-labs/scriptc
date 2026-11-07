// An HTTP server whose request and response handles stay typed: method,
// url, headers, a body, writeHead, write and end, answered to a client
// that speaks over a typed net socket. Nothing here boxes a handle, so the
// program links none of the net and HTTP units' checked-dynamic members
// (tests/harness/corpus-dynamic-tier.test.ts).
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    const host = req.headers.host ?? "";
    res.writeHead(req.url === "/missing" ? 404 : 200, {
      "content-type": "text/plain",
      "x-method": req.method ?? "",
    });
    res.write(`${req.method} ${req.url} host=${host.length > 0}\n`);
    res.end(`body=${body}`);
  });
});

const requests = [
  "GET /hello HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
  "POST /items HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
  "GET /missing HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
];

function send(port: number, index: number): void {
  if (index === requests.length) {
    server.close(() => console.log("closed"));
    return;
  }
  const socket = net.connect(port, "127.0.0.1", () => socket.write(requests[index]!));
  let reply = "";
  socket.on("data", (chunk: Buffer) => {
    reply += chunk.toString("utf8");
  });
  socket.on("close", () => {
    const head = reply.split("\r\n\r\n")[0]!.split("\r\n");
    const at = reply.indexOf("\r\n\r\n");
    console.log(head[0]);
    console.log(head.filter((line) => /^(content-type|x-method):/i.test(line)).join(" | "));
    console.log(JSON.stringify(at >= 0 ? reply.slice(at + 4) : ""));
    send(port, index + 1);
  });
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  send(address.port, 0);
});
