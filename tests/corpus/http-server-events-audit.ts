import { createServer } from "node:http";
import { connect } from "node:net";

type Socket = ReturnType<typeof connect>;
type Server = ReturnType<typeof createServer>;

const server = createServer((req, res) => {
  res.sendDate = false;
  console.log("request", req.method, req.url);
  res.writeHead(200, { "Content-Length": "2" });
  res.end("ok");
});
server.on("connection", (socket) => console.log("connection", typeof socket.remotePort === "number"));
server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
  console.log("clientError", error.code);
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.on("checkContinue", (req, res) => {
  console.log("checkContinue", req.headers.expect);
  res.sendDate = false;
  res.writeContinue();
  req.resume();
  req.on("end", () => res.end("continued"));
});
server.on("checkExpectation", (req, res) => {
  console.log("checkExpectation", req.headers.expect);
  res.sendDate = false;
  res.end("expected");
});
server.on("upgrade", (req, socket, head) => {
  console.log("upgrade", req.headers.upgrade, head.length);
  socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});
server.on("connect", (req, socket) => {
  console.log("connect", req.method, req.url);
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
});
server.on("close", () => console.log("server close"));

function port(): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function raw(label: string, payload: string, done: () => void): void {
  const socket = connect(port(), "127.0.0.1");
  let wire = "";
  socket.on("connect", () => socket.write(payload));
  socket.on("data", (chunk: Buffer) => {
    wire += chunk.toString("latin1");
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    console.log(label, wire.split("\r\n")[0] || "-");
    done();
  });
}

server.listen(0, "127.0.0.1", () => {
  raw("simple", "GET / HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n", () =>
    raw("malformed", "BAD\r\n\r\n", () =>
      raw(
        "continue",
        "POST /c HTTP/1.1\r\nHost: l\r\nExpect: 100-continue\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
        () =>
          raw(
            "expect",
            "GET /e HTTP/1.1\r\nHost: l\r\nExpect: something\r\nConnection: close\r\n\r\n",
            () =>
              raw(
                "upgrade",
                "GET /u HTTP/1.1\r\nHost: l\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
                () =>
                  raw("connect", "CONNECT host:443 HTTP/1.1\r\nHost: host:443\r\n\r\n", () =>
                    server.close(() => console.log("done")),
                  ),
              ),
          ),
      ),
    ),
  );
});
