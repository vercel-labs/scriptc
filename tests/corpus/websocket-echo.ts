// The global WebSocket client against a local RFC 6455 echo server: the
// handshake, text and binary frames in both directions, a message event per
// message, and a close handshake with its CloseEvent.
import * as http from "node:http";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// A complete server frame (servers never mask).
function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x80 | opcode;
  header[1] = 126;
  header[2] = length >> 8;
  header[3] = length & 0xff;
  return Buffer.concat([header, payload]);
}

const server = http.createServer((_req, res) => {
  res.writeHead(426);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const key = String(req.headers["sec-websocket-key"]);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(key) +
      "\r\n\r\n"
  );
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) break;
        length = (pending[2] << 8) | pending[3];
        offset = 4;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (pending.length < offset + length) break;
      let payload = pending.subarray(offset, offset + length);
      if (masked) {
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ pending[maskAt + (i & 3)];
        payload = unmasked;
      }
      pending = pending.subarray(offset + length);
      if (opcode === 8) {
        socket.write(serverFrame(8, payload));
        socket.end();
        continue;
      }
      if (opcode === 1) {
        console.log("server text", payload.toString());
        socket.write(serverFrame(1, payload));
      } else if (opcode === 2) {
        console.log("server binary", payload.length);
        socket.write(serverFrame(2, payload));
      }
    }
  });
  socket.on("error", () => socket.destroy());
});

server.listen(0, () => {
  const port = server.address().port;
  const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/echo");
  ws.binaryType = "arraybuffer";
  let messages = 0;
  ws.onopen = () => {
    console.log("open", ws.readyState, ws.url.endsWith("/echo"), ws.protocol, ws.extensions);
    ws.send("hello");
    ws.send(new Uint8Array([1, 2, 3]));
  };
  ws.onmessage = (event) => {
    messages++;
    if (typeof event.data === "string") {
      console.log("message text", event.data, event.type, event.target === ws);
    } else {
      console.log("message binary", Array.from(new Uint8Array(event.data as ArrayBuffer)).join(","));
    }
    if (messages === 2) ws.close(1000, "done");
  };
  ws.onclose = (event) => {
    console.log("close", event.code, event.reason, event.wasClean, event.isTrusted);
    server.close();
  };
});
