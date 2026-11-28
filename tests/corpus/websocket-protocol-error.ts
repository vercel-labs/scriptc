// A frame with the RSV bit set is a protocol violation: the error dispatch
// may drop the program's last reference, and the close that follows must
// still report from live state.
import * as http from "node:http";
import { createHash } from "node:crypto";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptFor = (key: string): string =>
  createHash("sha1").update(key + GUID).digest("base64");

const server = http.createServer((_req, res) => {
  res.writeHead(426);
  res.end();
});
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  const key = String(req.headers["sec-websocket-key"]);
  socket.on("error", () => {});
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(key) +
      "\r\n\r\n"
  );
  socket.write(Buffer.from([0xc1, 0x01, 0x61])); // RSV1 on a text frame
});

server.listen(0, "127.0.0.1", () => {
  let ws: WebSocket | null = new WebSocket(
    "ws://127.0.0.1:" + String(server.address().port) + "/bad"
  );
  ws.onerror = () => {
    console.log("error");
    ws = null; // drops the program's last reference during the dispatch
  };
  (ws as WebSocket).onclose = () => {
    console.log("close");
    server.close();
    process.exit(0);
  };
});
