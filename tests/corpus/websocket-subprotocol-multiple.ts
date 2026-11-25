// A server that answers with several subprotocol tokens has selected none:
// Node rejects the handshake, whether or not one of the listed tokens was
// offered, instead of adopting an invalid negotiated protocol.
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
      "\r\n" +
      "Sec-WebSocket-Protocol: chat, superchat\r\n" +
      "\r\n"
  );
});

// The program holds on to its socket for as long as it runs: a
// module-level binding is a program root, so the collector keeps the
// connection alive the way Node's native handle does.
let socket: WebSocket | null = null;

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/", ["chat"]);
  socket = ws;
  ws.onopen = () => {
    console.log("open", ws.protocol);
  };
  ws.onerror = () => {
    console.log("error");
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code, event.wasClean, event.reason);
    server.close();
    process.exit(0);
  };
});
