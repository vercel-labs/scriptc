// The 'upgrade' event: a request that asks to switch protocols is not
// answered by the request listener. Node emits 'upgrade' with the request,
// the socket and the bytes read past the headers (head), and the handler
// owns the socket from there: this one completes a WebSocket handshake with
// Sec-WebSocket-Accept, reads a masked frame that arrived with the request
// headers, echoes it unmasked, and closes with a close frame. A plain GET
// still reaches the request listener.
import * as http from "node:http";
import * as net from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  console.log("plain request", req.method, req.url);
  res.end("plain body");
});
server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
  console.log(
    "upgrade",
    req.method,
    req.url,
    req.headers.upgrade,
    req.headers["sec-websocket-version"],
  );
  console.log("head", head.length, head.toString("hex"));
  const key = String(req.headers["sec-websocket-key"]);
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  console.log("accept", accept);
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.on("data", (chunk: Buffer) => {
    const mask = chunk.subarray(2, 6);
    const payload = Buffer.alloc(chunk.length - 6);
    for (let i = 0; i < payload.length; i++) payload[i] = chunk[i + 6]! ^ mask[i % 4]!;
    console.log("server data", chunk.length, payload.toString("utf8"));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    socket.end(Buffer.from([0x88, 0x00]));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") return;
  const port = address.port;
  http.get({ host: "127.0.0.1", port, path: "/plain" }, (res: http.IncomingMessage) => {
    res.setEncoding("utf8");
    let body = "";
    res.on("data", (chunk: string) => {
      body += chunk;
    });
    res.on("end", () => {
      console.log("plain response", res.statusCode, body);
      upgrade(port);
    });
  });
});

function upgrade(port: number): void {
  const client = net.connect(port, "127.0.0.1", () => {
    // A masked text frame ("hi"), written with the request headers so the
    // parser reads it as the 'upgrade' event's head.
    const frame = Buffer.from([0x81, 0x82, 0x01, 0x02, 0x03, 0x04, 0x68 ^ 1, 0x69 ^ 2]);
    client.write(
      Buffer.concat([
        Buffer.from(
          "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ),
        frame,
      ]),
    );
  });
  let seen = "";
  let sent = false;
  client.on("data", (chunk: Buffer) => {
    seen += chunk.toString("latin1");
    if (!sent && seen.includes("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")) {
      sent = true;
      console.log(
        "handshake",
        seen.startsWith("HTTP/1.1 101 Switching Protocols\r\n"),
        seen.endsWith("\r\n\r\n"),
      );
      // A masked text frame ("bye").
      client.write(
        Buffer.from([0x81, 0x83, 0x0a, 0x0b, 0x0c, 0x0d, 0x62 ^ 10, 0x79 ^ 11, 0x65 ^ 12]),
      );
    }
  });
  client.on("end", () => {
    console.log("client tail", seen.includes("bye"), seen.endsWith("\u0088\u0000"));
    server.close(() => console.log("closed"));
  });
}
