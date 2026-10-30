// An accepted socket reads ahead before it has a consumer, as Node's
// stream does, so it sees the peer's FIN or reset: with only 'end' and
// 'close' listeners it emits 'end' and 'close' when the client ends, and
// 'error' (ECONNRESET) and 'close' when the client calls
// resetAndDestroy().
"use strict";
const net = require("net");

function run(label, finish, done) {
  const server = net.createServer((socket) => {
    socket.on("end", () => console.log(label, "server socket end"));
    socket.on("error", (err) => console.log(label, "server socket error", err.code, err.message));
    socket.on("close", (hadError) => {
      console.log(label, "server socket close", hadError);
      server.close(done);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => {
      setTimeout(() => finish(client), 20);
    });
  });
}

run("end:", (client) => client.end(), () =>
  run("destroy:", (client) => client.destroy(), () =>
    run("reset:", (client) => client.resetAndDestroy(), () => console.log("done")),
  ),
);
