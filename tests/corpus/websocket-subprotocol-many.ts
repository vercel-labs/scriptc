// Subprotocol validation handles a long list in one pass: a duplicate is
// rejected wherever it appears, and a long list of distinct tokens is
// offered whole (the request header carries all of them).
import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

const MANY = 2000;
const list: string[] = [];
for (let i = 0; i < MANY; i++) list.push("p" + String(i));

try {
  new WebSocket("ws://127.0.0.1:1/", ["dup", "x", "dup"]);
  console.log("no throw");
} catch (error) {
  const e = error as Error;
  console.log("duplicate", e.name, e.message);
}

const server = http.createServer();
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  const header = String(req.headers["sec-websocket-protocol"]);
  const offered = header.split(",");
  console.log("count", offered.length, "first", offered[0], "last", offered[offered.length - 1].trim());
  socket.on("error", () => {});
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Protocol: p0\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(String(req.headers["sec-websocket-key"])) +
      "\r\n\r\n"
  );
  socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
  socket.end();
});

server.listen(0, "127.0.0.1", () => {
  const ws = new WebSocket(
    "ws://127.0.0.1:" + String((server.address() as { port: number }).port) + "/",
    list
  );
  ws.onerror = () => {};
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code);
    server.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.log("timeout");
    process.exit(1);
  }, 2000);
});
