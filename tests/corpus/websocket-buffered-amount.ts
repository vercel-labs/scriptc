// bufferedAmount is the payload send() queued that the socket has not yet
// flushed: zero when idle, non-zero while a peer that stops reading holds
// the connection, and zero again once the peer reads and the queue drains.
import * as http from "node:http";
import { createHash } from "node:crypto";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptFor = (key: string): string =>
  createHash("sha1").update(key + GUID).digest("base64");

let peer: Socket | null = null;
let peerBytes = 0;
const server = http.createServer((_req, res) => {
  res.writeHead(426);
  res.end();
});
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  const key = String(req.headers["sec-websocket-key"]);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(key) +
      "\r\n\r\n"
  );
  peer = socket;
  socket.pause();
  socket.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => {
  const ws = new WebSocket("ws://127.0.0.1:" + String(server.address().port) + "/stall");
  ws.onopen = () => {
    console.log("idle", ws.bufferedAmount === 0);
    ws.send(new Uint8Array(16 * 1024 * 1024));
    console.log("queued", ws.bufferedAmount > 0);
    setTimeout(() => {
      console.log("peer stalled", ws.bufferedAmount > 0);
      const socket = peer as Socket | null;
      if (socket !== null) {
        socket.on("data", (chunk: Buffer) => {
          peerBytes += chunk.length;
        });
        socket.resume();
      }
      setTimeout(() => {
        console.log("drained", ws.bufferedAmount === 0, peerBytes > 0);
        ws.close();
        server.close();
        process.exit(0);
      }, 500);
    }, 100);
  };
});
