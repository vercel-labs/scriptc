// A paused socket still reads ahead to its high-water mark, so the peer's
// FIN reaches it: 'end' and 'close' fire without resume() — Node's paused
// stream keeps reading until its buffer fills.
const net = require("node:net");
const server = net.createServer((sock) => {
  console.log("accepted");
  sock.pause();
  sock.on("end", () => console.log("server end"));
  sock.on("close", () => {
    console.log("server close");
    server.close();
  });
});
server.listen(0, "127.0.0.1", () => {
  const c = net.connect(server.address().port, "127.0.0.1", () => {
    setTimeout(() => {
      console.log("destroying client");
      c.destroy();
    }, 30);
  });
});
