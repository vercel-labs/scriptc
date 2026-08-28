/* A continuously writing upgraded peer must not monopolize the native
 * socket-read loop. The driver starts a backpressure-aware flood after each
 * HTTP upgrade. Once all clients connect, the timer must still run and tear
 * the server down while every socket remains readable. */
import * as http from "node:http";

const CLIENTS = 8;
const TICKS = 50;
const destroyers: (() => void)[] = [];
let connected = 0;
let bytes = 0;
let ticks = 0;
let peerClosed = false;

const server = http.createServer((_req, res) => {
  res.writeHead(426);
  res.end();
});

function tick(): void {
  ticks++;
  if (ticks < TICKS) {
    setTimeout(() => tick(), 10);
    return;
  }
  console.log(
    `timers stayed live with ${connected} upgraded sockets`,
    bytes > 0,
    peerClosed,
  );
  for (const destroy of destroyers) destroy();
  server.close();
}

server.on("upgrade", (_req, socket, _head) => {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    peerClosed = true;
  });
  destroyers.push(() => socket.destroy());
  connected++;

  socket.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  if (connected === CLIENTS) {
    setTimeout(() => tick(), 10);
  }
});

server.listen(0, () => {
  process.stderr.write(`PORT ${server.address().port}\n`);
});
