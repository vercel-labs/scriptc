// The client's response parser applies Node's checks: a malformed status
// line, header line, Content-Length or Transfer-Encoding, or chunk makes the
// request emit an error with the parser's code and the message
// "Parse Error: <reason>". A Transfer-Encoding that does not end in chunked
// reads the body until the connection closes.
import * as http from "node:http";
import * as net from "node:net";

const cases: [string, string][] = [
  ["ok", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"],
  ["cl and te", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
  ["te and cl", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n0\r\n\r\n"],
  ["cr without lf", "HTTP/1.1 200 OK\r\nFoo: Bar\rContent-Length: 1\r\n\r\nx"],
  ["lf without cr", "HTTP/1.1 200 OK\r\nFoo: Bar\nContent-Length: 1\r\n\r\nx"],
  ["space before colon", "HTTP/1.1 200 OK\r\nContent-Length : 1\r\n\r\nx"],
  ["cl not digits", "HTTP/1.1 200 OK\r\nContent-Length: 1x\r\n\r\nx"],
  ["cl duplicate", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx"],
  ["te gzip", "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\nConnection: close\r\n\r\nabc"],
  ["te chunked gzip", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\nConnection: close\r\n\r\nabc"],
  ["nul in value", "HTTP/1.1 200 OK\r\nX: a\u0000b\r\nContent-Length: 1\r\n\r\nx"],
  ["bad name", "HTTP/1.1 200 OK\r\nX(Y): a\r\nContent-Length: 1\r\n\r\nx"],
  ["obs fold", "HTTP/1.1 200 OK\r\nX: a\r\n b\r\nContent-Length: 1\r\n\r\nx"],
  ["no reason", "HTTP/1.1 200\r\nContent-Length: 1\r\n\r\nx"],
  ["reason with controls", "HTTP/1.1 200 O\u0001K\r\nContent-Length: 1\r\n\r\nx"],
  ["status two digits", "HTTP/1.1 20 OK\r\nContent-Length: 1\r\n\r\nx"],
  ["status four digits", "HTTP/1.1 2000 OK\r\nContent-Length: 1\r\n\r\nx"],
  ["status 099", "HTTP/1.1 099 Low\r\nContent-Length: 1\r\n\r\nx"],
  ["version 1.2", "HTTP/1.2 200 OK\r\nContent-Length: 1\r\n\r\nx"],
  ["lowercase http", "http/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx"],
  ["two spaces", "HTTP/1.1  200 OK\r\nContent-Length: 1\r\n\r\nx"],
  ["bare lf", "HTTP/1.1 200 OK\nContent-Length: 1\n\nx"],
  ["chunk size bad", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"],
  ["chunk ext", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;a=b\r\nab\r\n0\r\n\r\n"],
  ["chunk data end", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabXX"],
];

let current = 0;
const server = net.createServer((socket) => {
  socket.on("error", () => {});
  socket.once("data", () => {
    socket.end(Buffer.from(cases[current]![1], "latin1"));
  });
});

function next(port: number): void {
  if (current === cases.length) {
    server.close();
    return;
  }
  const name = cases[current]![0];
  let settled = false;
  const settle = (line: string): void => {
    if (settled) return;
    settled = true;
    console.log(`${name}: ${line}`);
    current++;
    next(port);
  };
  const req = http.get({ host: "127.0.0.1", port, agent: false }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      body += chunk;
    });
    res.on("end", () => {
      settle(`${res.statusCode} ${JSON.stringify(res.statusMessage)} ${JSON.stringify(res.headers)} ${JSON.stringify(body)}`);
    });
  });
  req.on("error", (error: NodeJS.ErrnoException) => {
    settle(`error ${error.code} ${error.message}`);
  });
}

server.listen(0, "127.0.0.1", () => {
  next((server.address() as net.AddressInfo).port);
});
