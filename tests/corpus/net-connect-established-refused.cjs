// connect() on an accepted socket answers EISCONN, as Node's handle does,
// instead of dialing over the live descriptor.
const net = require("node:net");

const server = net.createServer((sock) => {
  sock.on("error", (err) => {
    console.log("accepted", err.code, err.address, err.port);
    sock.destroy();
    server.close();
  });
  sock.connect(9, "127.0.0.1");
});
server.listen(0, "127.0.0.1", () => {
  const client = net.connect(server.address().port, "127.0.0.1", () => {});
  client.on("error", () => {});
  setTimeout(() => client.destroy(), 200);
});
