// A frame that declares a payload over Node's 128 MiB message cap fails the
// connection from its header, so the client never buffers the announced
// bytes: the reported shape is the failed-connection pair, error then an
// unclean 1006 close.
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
  // Header only: an unmasked binary frame announcing 200 MiB, with no body.
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 0x7f;
  header.writeBigUInt64BE(200n * 1024n * 1024n, 2);
  socket.write(header);
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
