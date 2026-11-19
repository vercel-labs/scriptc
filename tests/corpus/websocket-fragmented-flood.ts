// A long message arriving as many tiny continuation frames: the client
// reassembles it with geometric buffer growth, so reassembly stays linear
// in the message size.
import * as http from "node:http";
import { createHash } from "node:crypto";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptFor = (key: string): string =>
  createHash("sha1").update(key + GUID).digest("base64");

const COUNT = 100000;
const message = Buffer.alloc(COUNT * 3);
for (let i = 0; i < COUNT; i++) {
  const at = i * 3;
  const opcode = i === 0 ? 0x01 : 0x00; // text, then continuations
  const fin = i === COUNT - 1 ? 0x80 : 0x00;
  message[at] = fin | opcode;
  message[at + 1] = 1; // unmasked, one-byte payload
  message[at + 2] = 97 + (i % 26);
}

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
  socket.write(message);
});

server.listen(0, "127.0.0.1", () => {
  const ws = new WebSocket("ws://127.0.0.1:" + String(server.address().port) + "/flood");
  ws.onmessage = (event) => {
    const text = event.data as string;
    console.log("message", text.length, text.slice(0, 3), text.slice(-3));
    ws.close();
    server.close();
    process.exit(0);
  };
});
