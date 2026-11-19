// Text messages and close reasons must be valid UTF-8: a peer that sends a
// truncated sequence fails the connection with 1007 (the application sees
// Node's error event and an unclean 1006 close).
import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

let upgrades = 0;
const clientLines: string[] = [];
const serverLines: string[] = [];
let casePending = 0;
let finished = false;

const server = http.createServer();
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  upgrades += 1;
  const which = upgrades;
  casePending += 1;
  socket.on("error", () => {});
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(String(req.headers["sec-websocket-key"])) +
      "\r\n\r\n"
  );
  if (which === 1) {
    // A text frame whose two bytes are not a complete sequence.
    socket.write(Buffer.from([0x81, 0x02, 0xc3, 0x28]));
  } else {
    // A close frame (1000) whose reason is not UTF-8.
    socket.write(Buffer.from([0x88, 0x05, 0x03, 0xe8, 0xc3, 0x28, 0x41]));
  }
  socket.on("data", (chunk: Buffer) => {
    // Decode the client's masked close frame and report its code.
    let length = chunk[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = (chunk[2] << 8) | chunk[3];
      offset = 4;
    }
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i++) payload[i] = chunk[offset + 4 + i] ^ chunk[offset + (i & 3)];
    const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 0;
    serverLines[which - 1] = "case " + String(which) + " client close code " + String(code);
    socket.end();
    casePending -= 1;
    finish();
  });
});

function finish(): void {
  if (finished || casePending !== 0 || upgrades < 2 || clientLines.length < 2) return;
  finished = true;
  for (let i = 0; i < 2; i++) {
    console.log(clientLines[i]);
    console.log(serverLines[i]);
  }
  server.close();
  process.exit(0);
}

function next(): void {
  const which = upgrades + 1;
  const ws = new WebSocket("ws://127.0.0.1:" + String((server.address() as { port: number }).port) + "/utf8");
  ws.onerror = () => {};
  ws.onmessage = (event: MessageEvent) => console.log("message", JSON.stringify(event.data));
  ws.onclose = (event: CloseEvent) => {
    clientLines[which - 1] =
      "case " + String(which) + " client " + String(event.code) + " " +
      JSON.stringify(event.reason) + " " + String(event.wasClean);
    if (upgrades < 2) {
      next();
    } else {
      finish();
    }
  };
}

server.listen(0, "127.0.0.1", () => {
  next();
  setTimeout(() => {
    if (finished) return;
    console.log("timeout");
    process.exit(1);
  }, 2000);
});
