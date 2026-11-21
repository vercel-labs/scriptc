// A binary message with binaryType's default ("blob"): the event carries a
// Blob whose payload is the frame's bytes (its size is the payload length,
// not a rendering of the bytes).
import * as http from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
}

const server = http.createServer();
server.on("upgrade", (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
  void head;
  const key = String(req.headers["sec-websocket-key"]);
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n"
  );
  socket.write(serverFrame(2, Buffer.from([1, 2, 250, 251])));
  socket.on("data", () => {});
});

server.listen(0, () => {
  const ws = new WebSocket("ws://127.0.0.1:" + String(server.address().port) + "/");
  ws.onmessage = (event) => {
    const blob = event.data as Blob;
    console.log("blob", typeof blob, blob.size, JSON.stringify(blob.type));
    process.exit(0);
  };
});
