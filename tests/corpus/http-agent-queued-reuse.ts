// The twin of the peer-closed case: a request queued behind maxSockets: 1
// on a keep-alive peer that stays open takes the socket the first request
// freed — one connection serves both, as in Node.
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
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
  });
  socket.on("close", () => console.log("peer close", id));
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let done = 0;
  const fetch = (path: string): void => {
    const req = http.get({ port, host: "127.0.0.1", path, agent }, (res: http.IncomingMessage) => {
      res.resume();
      res.on("end", () => {
        console.log("done", path, res.statusCode, req.reusedSocket);
        done += 1;
        if (done === 2) {
          setTimeout(() => {
            agent.destroy();
            peer.close();
          }, 10);
        }
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => console.log("error", path, err.code));
  };
  fetch("/a");
  fetch("/b");
});
