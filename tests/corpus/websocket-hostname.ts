// A WebSocket URL with a host name (not an IP literal) dials through the
// deferred connection: the constructor returns without resolving the name,
// and the handshake opens, carries a message and closes normally.
import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

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
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0]! & 0x0f;
      const masked = (pending[1]! & 0x80) !== 0;
      const length = pending[1]! & 0x7f;
      const maskAt = 2;
      const start = masked ? maskAt + 4 : maskAt;
      if (pending.length < start + length) break;
      let payload = pending.subarray(start, start + length);
      if (masked) {
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i++) unmasked[i] = payload[i]! ^ pending[maskAt + (i & 3)]!;
        payload = unmasked;
      }
      pending = pending.subarray(start + length);
      if (opcode === 8) {
        socket.write(serverFrame(8, payload));
        socket.end();
      } else if (opcode === 1) {
        socket.write(serverFrame(1, payload));
      }
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket("ws://localhost:" + String(port) + "/");
  const keepAlive = ws;
  ws.onopen = () => {
    console.log("open", ws.readyState, ws.url.endsWith("/"));
    ws.send("hello");
  };
  ws.onmessage = (event: MessageEvent) => {
    console.log("message", event.data, keepAlive.readyState);
    ws.close(1000);
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code, event.wasClean);
    server.close();
  };
});
