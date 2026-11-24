// A request queued behind maxSockets: 1 must not be served on a keep-alive
// socket whose peer has already closed it. The second request runs from the
// first response's 'end' handler, while the freed socket's own close (the
// peer's FIN) may still be in flight; it has to dial a fresh connection
// instead of reusing the dying one, as Node does.
import * as http from "node:http";
import * as net from "node:net";

let accepts = 0;
const peer = net.createServer((socket) => {
  accepts += 1;
  const id = accepts;
  let text = "";
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) return;
    console.log("peer", id, JSON.stringify(text.slice(0, end).split("\r\n")[0] ?? ""));
    text = "";
    // answer and half-close: the FIN follows the response at once
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
  });
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const fetch = (path: string, next: () => void): void => {
    const req = http.get({ port, host: "127.0.0.1", path, agent }, (res: http.IncomingMessage) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        console.log("done", path, res.statusCode, JSON.stringify(body), req.reusedSocket);
        next();
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log("error", path, err.code);
      next();
    });
  };
  fetch("/one", () => {
    fetch("/two", () => {
      setTimeout(() => {
        agent.destroy();
        peer.close();
      }, 10);
    });
  });
});
