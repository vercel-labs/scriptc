// An untyped connect listener on an HTTP/2 server receives the
// compatibility response for a CONNECT stream: (req, res), no head bytes,
// and the request handler never runs for it. The response the listener
// writes reaches the client, and ordinary requests still reach the handler.
import http2 from "node:http2";

const server = http2.createServer((req, res) => {
  console.log("request", req.method, req.url);
  res.end("ok");
});
server.on("connect", (req, socket, head) => {
  console.log("connect", req.method, head === undefined, typeof socket);
  socket.writeHead(200, { "x-c": "1" });
  socket.end("tunneled");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const client = http2.connect("http://127.0.0.1:" + port);
  const tunnel = client.request({ ":method": "CONNECT", ":authority": "example.com:443" });
  tunnel.on("response", (h) => console.log("tunnel", h[":status"], JSON.stringify(h["x-c"] ?? null)));
  let body = "";
  tunnel.on("data", (c) => (body += c));
  tunnel.on("end", () => {
    console.log("tunnel body", JSON.stringify(body));
    const plain = client.request({ ":path": "/plain" });
    plain.on("response", (h) => console.log("plain", h[":status"]));
    let pbody = "";
    plain.on("data", (c) => (pbody += c));
    plain.on("end", () => {
      console.log("plain body", JSON.stringify(pbody));
      client.close();
      server.close();
    });
    plain.end();
  });
  tunnel.end();
});
