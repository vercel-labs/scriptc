// Clients that disconnect before a delayed res.end() whose callback captures
// the response and a 64 KiB buffer: as in Node, neither the end callback nor
// 'finish' runs, and the responses are released, so the buffer storage the
// program holds (process.memoryUsage().arrayBuffers) stays bounded.
import * as http from "node:http";
import * as net from "node:net";

const ROUNDS = 1500;
let round = 0;
let closes = 0;
let aborts = 0;
let finishes = 0;
let endCallbacks = 0;
let midBuffers = 0;
let client: net.Socket;

const server = http.createServer((req, res) => {
  const big = Buffer.alloc(64 * 1024, round & 0xff);
  req.on("aborted", () => aborts++);
  res.on("finish", () => finishes++);
  res.on("close", () => {
    closes++;
    setTimeout(() => {
      res.end("late", () => {
        endCallbacks += big.length + (res.writableEnded ? 1 : 0);
      });
      next();
    }, 1);
  });
  client.destroy();
});

function next(): void {
  round++;
  if (round === 500) midBuffers = process.memoryUsage().arrayBuffers;
  if (round > ROUNDS) {
    const growth = process.memoryUsage().arrayBuffers - midBuffers;
    console.log("closes", closes, "aborts", aborts, "finishes", finishes, "end callbacks", endCallbacks);
    console.log("buffer growth under 32 MiB", growth < 32 * 1024 * 1024);
    server.close(() => console.log("closed"));
    return;
  }
  const port = (server.address() as net.AddressInfo).port;
  client = net.connect(port, "127.0.0.1", () => {
    client.write("GET / HTTP/1.1\r\nHost: a\r\n\r\n");
  });
  client.on("error", () => {});
}

server.listen(0, "127.0.0.1", () => next());
