// The WebSocket ready-state constants belong to the interface, so both
// `WebSocket.OPEN` and `ws.OPEN` answer the same number. A guard such as
// `ws.readyState === ws.OPEN` therefore works on an instance, as in Node.
import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

const server = http.createServer((_req, res) => {
  res.writeHead(426);
  res.end();
});

server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  socket.on("error", () => {});
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(String(req.headers["sec-websocket-key"])) +
      "\r\n\r\n"
  );
  // The client's close frame: answer with a 1000 close and finish.
  socket.on("data", () => {
    socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
  });
});

// The program holds on to its socket for as long as it runs: a
// module-level binding is a program root, so the collector keeps the
// connection alive the way Node's native handle does.
let socket: WebSocket | null = null;

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  console.log(
    "static",
    WebSocket.CONNECTING,
    WebSocket.OPEN,
    WebSocket.CLOSING,
    WebSocket.CLOSED
  );
  const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/");
  socket = ws;
  console.log("connecting", ws.readyState, ws.readyState === ws.CONNECTING);
  ws.onopen = () => {
    console.log("instance", ws.CONNECTING, ws.OPEN, ws.CLOSING, ws.CLOSED);
    console.log("open", ws.readyState === ws.OPEN, ws.readyState === WebSocket.OPEN);
    ws.close(1000);
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("closed", event.code, ws.readyState === ws.CLOSED, ws.readyState);
    server.close();
    process.exit(0);
  };
});
