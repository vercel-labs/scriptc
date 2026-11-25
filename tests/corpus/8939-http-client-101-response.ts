// What http.get sees when a server answers 101. A 101 switches protocols only when it carries an Upgrade header
// and a Connection header that names it: then 'upgrade' fires instead of 'response', and without an 'upgrade'
// listener the connection is destroyed and the request ends in 'close' alone. Any other 101 is an ordinary final
// response that ends at its head, whatever body it declares. In every case the request settles.
import { get } from "node:http";
import { createServer } from "node:net";

const responses: [string, string][] = [
  ["upgrade", "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"],
  ["no headers", "HTTP/1.1 101 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n"],
  ["upgrade header only", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"],
  ["connection header only", "HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\n\r\n"],
  ["content-length", "HTTP/1.1 101 Switching Protocols\r\nContent-Length: 5\r\n\r\nhello"],
  ["chunked", "HTTP/1.1 101 Switching Protocols\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n"],
];

const server = createServer((socket) => {
  socket.on("error", () => {});
  socket.once("data", (data: Buffer) => {
    const index = Number(/^GET \/(\d+) /.exec(data.toString("latin1"))?.[1] ?? "0");
    socket.end(Buffer.from(responses[index]?.[1] ?? "", "latin1"));
  });
});

// One request; resolves with its events once the request has closed and one more turn has passed, so a response's
// own 'close' is in the list.
function request(port: number, index: number, listen: boolean): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const events: string[] = [];
    const req = get({ host: "127.0.0.1", port, path: "/" + index, headers: { connection: "close" } }, (res) => {
      let length = 0;
      events.push("response " + res.statusCode);
      res.on("data", (c: Buffer) => {
        length += c.length;
      });
      res.on("end", () => events.push("response end, body " + length));
      res.on("error", (e: Error) => events.push("response error " + e.message));
      res.on("close", () => events.push("response close"));
    });
    if (listen) {
      req.on("upgrade", (res, socket, head) => {
        events.push("upgrade " + res.statusCode + ", head " + head.length);
        socket.destroy();
      });
    }
    req.on("error", (e: Error) => events.push("request error " + e.message));
    req.on("close", () => {
      events.push("request close");
      setTimeout(() => resolve(events), 20);
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  for (let index = 0; index < responses.length; index++) {
    for (const listen of [false, true]) {
      const events = await request(port, index, listen);
      console.log(`${responses[index]?.[0]}, ${listen ? "with" : "without"} an 'upgrade' listener: ${events.join("; ")}`);
    }
  }
  server.close();
});
