// Each connection's handlers close over their own socket, so a closed
// socket, its listeners and its receive buffers form a cycle: the socket
// holds its listeners and a listener's closure holds the socket's handle.
// Under the sanitized lane's RC audit, one still live at exit fails the run.
import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

const ROUNDS = 40;
let closed = 0;

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
  // A clean close (1000) right after the handshake.
  socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
  socket.end();
});

server.listen(0, "127.0.0.1", () => {
  const url = "ws://127.0.0.1:" + String((server.address() as { port: number }).port) + "/loop";

  function round(i: number): void {
    if (i === ROUNDS) {
      console.log("rounds", closed);
      server.close();
      process.exit(0);
      return;
    }
    const ws = new WebSocket(url);
    ws.onmessage = () => console.log("unexpected message");
    ws.onclose = (event: CloseEvent) => {
      // The handler captures its own socket: the cycle under test.
      if (ws.readyState === 3 && event.code === 1000) closed += 1;
      round(i + 1);
    };
  }

  round(0);
  setTimeout(() => {
    console.log("timeout", closed);
    process.exit(1);
  }, 5000);
});
