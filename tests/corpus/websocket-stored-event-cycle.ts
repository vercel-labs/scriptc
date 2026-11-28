// A connection handler that keeps its last MessageEvent leaves the event's
// target holding the socket, the socket holding its handlers and a handler
// holding the event: once the connection is over and the program drops it,
// the whole graph is garbage. The sanitized lane's reference audit fails if
// it stays live.
import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

const ROUNDS = 25;
let closed = 0;

const server = http.createServer();
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
  // One text message, then a clean close.
  socket.write(Buffer.from([0x81, 0x01, 0x61]));
  socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
  socket.end();
});

server.listen(0, "127.0.0.1", () => {
  const url = "ws://127.0.0.1:" + String((server.address() as { port: number }).port) + "/stored";

  function round(i: number): void {
    if (i === ROUNDS) {
      console.log("rounds", closed);
      server.close();
      process.exit(0);
      return;
    }
    const ws = new WebSocket(url);
    // The handler keeps the event for bookkeeping and never clears it.
    let kept: MessageEvent | null = null;
    ws.onmessage = (event: MessageEvent) => {
      kept = event;
    };
    ws.onclose = () => {
      if (kept !== null) closed += 1;
      round(i + 1);
    };
  }

  round(0);
  setTimeout(() => {
    console.log("timeout", closed);
    process.exit(1);
  }, 5000);
});
