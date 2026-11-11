// request.maxHeadersCount caps the response headers a client keeps: Node's
// parser stops at twice that many name/value entries and the rest of the
// head parses on unread, so an over-limit response still arrives complete,
// with only the first lines of its header block. null (the default), 0 and
// negatives keep every line.
import * as http from "node:http";
import * as net from "node:net";

// One raw server for every exchange; each connection takes the next header
// count from the queue and answers with that many X-Pad lines.
const queue: number[] = [];
const server = net.createServer((socket) => {
  const lines = queue.shift() ?? 0;
  let text = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n";
  for (let i = 0; i < lines; i++) text += `X-Pad-${i}: v\r\n`;
  socket.end(text + "\r\nok", () => socket.destroy());
});

function get(port: number, value: number | null, headerLines: number): Promise<void> {
  return new Promise<void>((resolve) => {
    queue.push(headerLines);
    const req = http.request({ host: "127.0.0.1", port, agent: false }, (res) => {
      const names = Object.keys(res.headers).sort();
      console.log("max", value, "lines", headerLines, "->", res.statusCode, names.join(","));
      res.resume();
      res.on("end", () => resolve());
    });
    req.maxHeadersCount = value;
    console.log("max", value, "read", req.maxHeadersCount);
    req.on("error", (err) => {
      console.log("max", value, "error", (err as NodeJS.ErrnoException).code);
      resolve();
    });
    req.end();
  });
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await get(port, null, 3);
  await get(port, 2, 3);
  await get(port, 2, 2);
  await get(port, 1.9, 2);
  await get(port, 0, 8);
  await get(port, -1, 8);
  await get(port, 5, 3);
  server.close();
}

void main();
