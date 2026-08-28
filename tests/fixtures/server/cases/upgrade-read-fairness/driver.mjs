import net from "node:net";

const CLIENTS = 8;
const payload = Buffer.alloc(1024 * 1024, 0x61);
const port = Number(process.argv[2]);
const sockets = [];
let closed = 0;

function flood(socket) {
  if (socket.destroyed) return;
  if (socket.write(payload)) setImmediate(() => flood(socket));
  else socket.once("drain", () => flood(socket));
}

for (let i = 0; i < CLIENTS; i++) {
  const socket = net.connect(port, "127.0.0.1");
  let handshake = "";
  socket.on("connect", () => {
    socket.write(
      `GET /${i} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
  });
  socket.on("data", (chunk) => {
    if (handshake.endsWith("\r\n\r\n")) return;
    handshake += chunk.toString("latin1");
    if (!handshake.includes("\r\n\r\n")) return;
    flood(socket);
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed++;
    if (closed === CLIENTS) {
      clearTimeout(watchdog);
      console.log(`driver closed ${closed} sockets`);
    }
  });
  sockets.push(socket);
}

const watchdog = setTimeout(() => {
  for (const socket of sockets) socket.destroy();
}, 1_000);
