// Plain-JavaScript listeners for the socket-handover events: an untyped
// function's parameters (no annotations, no contextual type) are dynamic,
// and they cross into the typed native event payload the same way an
// untyped 'request' handler does — the connect/upgrade listener still gets
// the request, the raw socket and the head bytes, and can use them.
import http from "node:http";
import net from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.url);
  res.end("no");
});
server.on("connect", (req, socket, head) => {
  console.log(
    "connect",
    req.method,
    req.url,
    JSON.stringify(req.headers.host ?? null),
    Buffer.isBuffer(head),
    head.length,
    req.socket === socket,
  );
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
});
server.on("upgrade", (req, socket, head) => {
  console.log(
    "upgrade",
    req.method,
    req.url,
    JSON.stringify(req.headers.upgrade ?? null),
    Buffer.isBuffer(head),
    head.length,
  );
  socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
});

const send = (request, next) => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {
    client.write(request);
  });
  let seen = "";
  client.on("data", (chunk) => (seen += chunk.toString("utf8")));
  client.on("close", () => {
    console.log("client", JSON.stringify(seen.split("\r\n")[0] ?? ""));
    next();
  });
};

server.listen(0, "127.0.0.1", () => {
  send("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n", () => {
    send(
      "GET /socket HTTP/1.1\r\nHost: example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      () => server.close(),
    );
  });
});
