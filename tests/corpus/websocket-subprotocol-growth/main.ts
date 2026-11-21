// The constructor reads the offered subprotocols off the array before any
// element's ToString runs: a toString that pushes to the array must not be
// reached through the array's freed backing.
import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { connect } from "./client.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

const server = http.createServer();
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  console.log("offered", JSON.stringify(String(req.headers["sec-websocket-protocol"])));
  socket.on("error", () => {});
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Protocol: first\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(String(req.headers["sec-websocket-key"])) +
      "\r\n\r\n"
  );
  socket.on("data", () => socket.end());
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const { ws, protocols } = connect("ws://127.0.0.1:" + String(port) + "/");
  ws.onerror = () => {};
  ws.onopen = () => {
    console.log("open", ws.protocol, JSON.stringify(protocols));
    ws.close(1000);
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code);
    server.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.log("timeout");
    process.exit(1);
  }, 500);
});
