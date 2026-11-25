// connect({ signal }): the abort registration belongs to the socket and is
// disposed at 'close'. The controller dies with the function that made it,
// so a registration left behind would be the only holder of the closed
// socket — the sanitized lane's reference-count audit reports that cycle at
// exit. The socket is destroyed from its own 'connect' listener so the
// program reaches close with the signal still live.
const net = require("node:net");

function connectAndDestroy(port, next) {
  const controller = new AbortController();
  const socket = net.connect({ port, signal: controller.signal });
  socket.on("connect", () => socket.destroy());
  socket.on("close", () => {
    console.log("closed", socket.destroyed, controller.signal.aborted);
    next();
  });
}

const server = net.createServer((socket) => socket.end());
server.listen(0, () => {
  const port = server.address().port;
  connectAndDestroy(port, () => {
    connectAndDestroy(port, () => {
      server.close(() => console.log("done"));
    });
  });
});
