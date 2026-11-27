// A response's write callback is paced by the connection: a peer that reads
// slowly holds the callbacks back, so callback-driven streaming cannot queue
// the whole body in memory up front.
import * as http from "node:http";
import * as net from "node:net";

const CHUNK = "z".repeat(1 << 16);
const COUNT = 512; // 32 MB: far beyond any socket buffer
let clientResumed = false;

const server = http.createServer((req, res) => {
  let sent = 0;
  const next = (): void => {
    if (sent === COUNT) {
      console.log("body written");
      res.end(() => {
        console.log("end callback, client had resumed:", clientResumed);
        server.close();
      });
      return;
    }
    sent += 1;
    res.write(CHUNK, next);
  };
  next();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = net.connect(port, "127.0.0.1", () => {
    client.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    client.pause();
    console.log("client pauses");
    setTimeout(() => {
      clientResumed = true;
      console.log("client resumes");
      let bytes = 0;
      client.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      client.on("end", () => {
        console.log("client end", bytes);
      });
      client.resume();
    }, 150);
  });
  client.on("error", () => {});
});
