// A response that fails the parser's checks destroys the client's socket,
// as Node's does: the server, which writes a malformed head and reads its
// socket, sees the client's end and closes, and the program exits after the
// request's error.
import * as http from "node:http";
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.resume();
  socket.on("end", () => console.log("server socket end"));
  socket.on("close", () => console.log("server socket close"));
  socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const req = http.get({ host: "127.0.0.1", port, agent: false }, () => console.log("response"));
  req.on("close", () => console.log("request close"));
  req.on("error", (err: NodeJS.ErrnoException) => {
    console.log("error", err.code, err.message);
    server.close(() => console.log("server closed"));
  });
});
