// A timer that comes due while ready I/O keeps queueing immediates must still
// fire: the check phase a poll callback's setImmediate belongs to runs before
// the next timers phase, not instead of it. A socket fed for the whole
// transfer keeps the poll dispatch stocked, and every read queues an
// immediate, so a loop that defers timers once per check phase never reaches
// its timers phase and starves the timer until the transfer ends.
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { rmSync } = require("node:fs");

const socketPath = path.join(os.tmpdir(), `scriptc-loop-starvation-${process.pid}.sock`);
rmSync(socketPath, { force: true });

const total = 64 * 1024 * 1024;
const chunk = Buffer.alloc(64 * 1024);
let sent = 0;
let received = 0;
let timerFiredAt = -1;

const server = net.createServer((socket) => {
  socket.on("data", (data) => {
    received += data.length;
    setImmediate(() => {});
    if (received >= total) socket.destroy();
  });
});

server.listen(socketPath, () => {
  const client = net.connect(socketPath, () => {
    const writeMore = () => {
      if (sent >= total) {
        client.end();
        return;
      }
      sent += chunk.length;
      if (client.write(chunk)) setImmediate(writeMore);
      else client.once("drain", writeMore);
    };
    writeMore();
  });
  client.on("error", () => {});
});

setTimeout(() => {
  timerFiredAt = received;
}, 0);

server.on("connection", (socket) => socket.on("close", () => server.close()));

server.on("close", () => {
  rmSync(socketPath, { force: true });
  // Let a timer the loop deferred during the transfer land before judging.
  setTimeout(() => {
    console.log("timer before end:", timerFiredAt >= 0 && timerFiredAt < total);
    console.log("received all:", received >= total);
  }, 50);
});
