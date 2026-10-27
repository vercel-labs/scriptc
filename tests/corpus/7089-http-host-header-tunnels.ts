// An HTTP/1.1 request without a Host header gets 400 Bad Request, except
// the requests that leave the parser first: an upgrade an 'upgrade'
// listener takes, and a CONNECT (destroyed here, with no 'connect'
// listener).
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((_req, res) => res.end("request"));
server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
  console.log("upgrade", req.url, req.headers.host);
  socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
});
function probe(head: string, next: () => void): void {
  const port = (server.address() as net.AddressInfo).port;
  const raw = net.connect(port, "127.0.0.1", () => raw.write(head));
  let got = "";
  raw.on("data", (d: Buffer) => {
    got += d.toString();
  });
  raw.on("close", () => {
    console.log("got", JSON.stringify(got.split("\r\n")[0]));
    next();
  });
}
server.listen(0, "127.0.0.1", () => {
  probe("GET /ws HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n", () =>
    probe("CONNECT a:1 HTTP/1.1\r\n\r\n", () =>
      probe("GET / HTTP/1.1\r\nConnection: close\r\n\r\n", () => server.close()),
    ),
  );
});
