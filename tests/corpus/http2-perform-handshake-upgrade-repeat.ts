// Repeat the HTTP/1 upgrade -> http2.performServerHandshake -> destroy
// handoff: each handoff retires the parser's context to the socket and the
// socket releases it, so memory stays bounded (the LeakSanitizer companion
// test runs this with detect_leaks=1; a leak here grows with remote clients).
import * as http from "node:http";
import * as http2 from "node:http2";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

const HANDS = 50;
const lines: string[] = [];
let handoffs = 0;
let sessionsClosed = 0;
let onAllClosed: (() => void) | null = null;

function noteSessionClosed(): void {
  sessionsClosed++;
  if (sessionsClosed === HANDS && onAllClosed !== null) onAllClosed();
}

function allSessionsClosed(): Promise<void> {
  if (sessionsClosed === HANDS) return Promise.resolve();
  return new Promise((resolve) => {
    onAllClosed = resolve;
  });
}

const server = http.createServer((req, res) => {
  res.end("http");
});
server.on("upgrade", (req, socket, head) => {
  handoffs++;
  const session = http2.performServerHandshake(socket);
  session.on("close", noteSessionClosed);
  session.on("error", () => {});
  socket.destroy();
});

function handoff(port: number): Promise<void> {
  return new Promise((resolve) => {
    const client = connect(port, "127.0.0.1", () => {
      client.write("GET /upgrade HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n");
    });
    client.on("data", () => {});
    client.on("error", () => {});
    client.on("close", () => resolve());
  });
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
for (let i = 0; i < HANDS; i++) await handoff(port);
await allSessionsClosed();
await new Promise<void>((resolve) => server.close(() => resolve()));
lines.push(`handoffs ${handoffs}`);
lines.push(`sessions closed ${sessionsClosed}`);
lines.push("server closed");
for (const line of lines) console.log(line);
