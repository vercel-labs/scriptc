// Calling close() from a message handler stops the messages already
// buffered behind it from being delivered, as in Node, while the close
// handshake with the peer still completes.
import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// A complete server frame (servers never mask).
function serverFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
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
  // Two messages and the close arrive together, so the second message is
  // already buffered when the first handler runs.
  socket.end(
    Buffer.concat([
      serverFrame(1, Buffer.from("one")),
      serverFrame(1, Buffer.from("two")),
      serverFrame(8, Buffer.from([0x03, 0xe8])),
    ])
  );
});

// The program holds on to its socket for as long as it runs: a
// module-level binding is a program root, so the collector keeps the
// connection alive the way Node's native handle does.
let socket: WebSocket | null = null;

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/");
  socket = ws;
  const seen: string[] = [];
  ws.onmessage = (event: MessageEvent) => {
    seen.push(String(event.data));
    console.log("message", event.data, ws.readyState);
    ws.close(1000, "bye");
    console.log("closing", ws.readyState);
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code, event.reason, event.wasClean, seen.length);
    server.close();
    process.exit(0);
  };
});
