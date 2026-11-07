// A chunk extension's quoted value counts toward the 16 KiB extension limit
// while it is still open (413), and a chunk size may have any number of
// leading zeros, as in Node's parser.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => (body += chunk));
  req.on("end", () => {
    console.log("request body", JSON.stringify(body));
    res.end("ok");
  });
});

function send(label: string, parts: string[], done: () => void): void {
  const port = (server.address() as net.AddressInfo).port;
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.write("POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
    for (const part of parts) socket.write(part);
  });
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => (reply += chunk));
  socket.on("error", () => {});
  socket.on("close", () => {
    console.log(label, reply.split("\r\n")[0]);
    done();
  });
}

server.listen(0, "127.0.0.1", () => {
  const open = '5;name="' + "x".repeat(8192);
  send("unterminated quoted extension", [open, "y".repeat(8192), "z".repeat(8192)], () => {
    send("leading zeros", ["0".repeat(40000), "5\r\nhello\r\n0\r\n\r\n"], () => {
      send("last chunk zeros", ["3\r\nabc\r\n", "0".repeat(40000), "\r\n\r\n"], () => {
        server.close(() => console.log("closed"));
      });
    });
  });
});
