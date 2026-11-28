// A proxy policy that changes while a hostname dial's lookup is pending does
// not apply to that dial: the connection goes where it was decided to go, and
// the origin never sees a proxy's credentials. Node answers the same — the
// request that was built for a direct connection stays direct.
import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

const server = http.createServer();
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  socket.on("error", () => {});
  console.log("upgrade", JSON.stringify(req.headers["proxy-authorization"] ?? "none"));
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(String(req.headers["sec-websocket-key"])) +
      "\r\n\r\n"
  );
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0]! & 0x0f;
      const masked = (pending[1]! & 0x80) !== 0;
      const length = pending[1]! & 0x7f;
      const maskAt = 2;
      const start = masked ? maskAt + 4 : maskAt;
      if (pending.length < start + length) break;
      let payload = pending.subarray(start, start + length);
      if (masked) {
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i++) unmasked[i] = payload[i]! ^ pending[maskAt + (i & 3)]!;
        payload = unmasked;
      }
      pending = pending.subarray(start + length);
      if (opcode === 8) {
        socket.write(serverFrame(8, payload));
        socket.end();
      }
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  // An authenticated proxy that is not this peer, ready in the environment
  // but not enabled when the connection is queued.
  process.env.HTTP_PROXY = "http://user:secret@127.0.0.1:9";
  process.env.NO_PROXY = "";
  const ws = new WebSocket("ws://localhost:" + String(port) + "/");
  // The dial decided the transport with no proxy configured; while its lookup
  // is pending, the process-wide policy turns the proxy on.
  setTimeout(() => {
    http.setGlobalProxyFromEnv();
  }, 0);
  ws.onopen = () => {
    console.log("open");
    ws.close(1000);
  };
  ws.onclose = (event: CloseEvent) => {
    console.log("close", event.code, event.wasClean);
    server.close();
  };
});
