// Node's WebSocket parser caps a message at 131072 fragments; a peer that
// keeps the reassembly alive with more fails the connection instead.
import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// One frame past the cap: a text frame and 131072 continuations.
const FRAMES = 131073;

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
  const frames = Buffer.alloc(FRAMES * 3);
  let at = 0;
  frames[at++] = 0x01; // text, not final
  frames[at++] = 0x01;
  frames[at++] = 0x61;
  for (let i = 1; i < FRAMES; i++) {
    frames[at++] = i === FRAMES - 1 ? 0x80 : 0x00;
    frames[at++] = 0x01;
    frames[at++] = 0x61;
  }
  socket.write(frames);
});

// The program holds on to its socket for as long as it runs: a
// module-level binding is a program root, so the collector keeps the
// connection alive the way Node's native handle does.
let socket: WebSocket | null = null;

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/");
  socket = ws;
  ws.onopen = () => {
    console.log("open");
  };
  ws.onmessage = () => {
    console.log("message");
  };
  ws.onerror = () => {
    console.log("error");
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code, event.wasClean);
    server.close();
    process.exit(0);
  };
});
