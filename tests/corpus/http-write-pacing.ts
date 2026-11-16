// A request's write callback is paced by the destination: a peer that reads
// slowly holds the callbacks back, so callback-driven uploads cannot queue
// the whole body in memory up front.
import * as http from "node:http";
import * as net from "node:net";

const CHUNK = "y".repeat(1 << 16);
const COUNT = 512; // 32 MB: far beyond any socket buffer
let peerResumed = false;
let received = 0;

const peer = net.createServer((socket) => {
  socket.pause();
  setTimeout(() => {
    peerResumed = true;
    console.log("peer starts reading");
    socket.resume();
  }, 150);
  let body = "";
  let answered = false;
  socket.on("data", (buf) => {
    received += buf.length;
    body += buf.toString("latin1");
    if (!answered && body.includes("\r\n0\r\n\r\n")) {
      answered = true;
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
  });
  socket.on("error", () => {});
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("response end, peer had resumed:", peerResumed);
      console.log("received", received);
      peer.close();
    });
  });
  let sent = 0;
  const next = (): void => {
    if (sent === COUNT) {
      console.log("upload done");
      req.end();
      return;
    }
    sent += 1;
    req.write(CHUNK, next);
  };
  next();
});
