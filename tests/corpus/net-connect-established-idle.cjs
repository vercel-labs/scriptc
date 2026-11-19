// connect() on an idle accepted socket answers EISCONN right away: the error
// is deferred work of its own, not something the next unrelated socket
// activity has to wake.
const net = require("node:net");

let client;
const server = net.createServer((sock) => {
  sock.on("error", (err) => {
    console.log("accepted", err.code, err.address, err.port);
    sock.destroy();
    server.close();
    client.destroy();
  });
  sock.connect(9, "127.0.0.1");
});
server.listen(0, "127.0.0.1", () => {
  client = net.connect(server.address().port, "127.0.0.1", () => {
    client.pause(); // an idle connection: no traffic to wake the sweep
  });
  client.on("error", () => {});
  setTimeout(() => {
    console.log("timeout");
    try {
      client.destroy();
    } catch {}
    try {
      server.close();
    } catch {}
  }, 200);
});
