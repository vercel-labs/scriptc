// server.on('clientError', (err, socket)) receives a request the parser
// rejects, with Node's code and "Parse Error: <reason>" message, instead of
// the default 400; the listener answers on the socket. A later valid
// request on another connection reaches the handler.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => res.end(`ok ${req.url}`));
server.on("clientError", (err: NodeJS.ErrnoException, socket: net.Socket) => {
  console.log("clientError", err.code, err.message);
  socket.end("HTTP/1.1 418 Custom\r\nConnection: close\r\n\r\n");
});

const cases = [
  "GET / HTTP/1.1\r\nHost: a\r\nContent-Length : 5\r\n\r\nhello",
  "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  "GET / HTTP/1.2\r\nHost: a\r\n\r\n",
  "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
  "GET /valid HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
];

function send(port: number, index: number): void {
  if (index === cases.length) {
    server.close();
    return;
  }
  const sock = net.connect(port, "127.0.0.1", () => sock.write(cases[index]!));
  let reply = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    reply += chunk;
  });
  sock.on("close", () => {
    const at = reply.indexOf("\r\n\r\n");
    console.log("reply", reply.split("\r\n")[0], at >= 0 ? reply.slice(at + 4) : "");
    send(port, index + 1);
  });
}

server.listen(0, "127.0.0.1", () => send((server.address() as net.AddressInfo).port, 0));
