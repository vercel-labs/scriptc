// The happy-eyeballs attempt events ('connectionAttempt',
// 'connectionAttemptFailed', 'connectionAttemptTimeout') are cleared when the
// socket closes. A listener that captures its own socket therefore stops
// keeping the closed socket reachable: a connection that settles normally
// leaves nothing behind, even with an unfired once-timeout listener.
const net = require("node:net");

function lookupAnswering(address) {
  return (_host, _options, callback) => {
    setImmediate(() => callback(null, [{ address, family: 4 }]));
  };
}

const server = net.createServer((conn) => conn.on("error", () => {}));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;

  function one(label, next) {
    const socket = net.connect({
      host: label + ".example",
      port,
      autoSelectFamily: true,
      lookup: lookupAnswering("127.0.0.1"),
    });
    socket.on("connectionAttempt", () => console.log(label, "attempt", socket.remotePort === port));
    socket.once("connectionAttemptTimeout", () => console.log(label, "timeout", socket.remotePort));
    socket.once("connectionAttemptFailed", () => console.log(label, "failed", socket.remotePort));
    socket.on("error", () => {});
    socket.on("connect", () => {
      console.log(label, "connected");
      socket.destroy();
    });
    socket.on("close", next);
  }

  one("first", () => one("second", () => server.close(() => console.log("closed"))));
});
