// agent.createConnection(options[, callback]): Node's default dialer is
// net.createConnection, so the call dials the same connection and the
// callback rides the 'connect' event.
import * as http from "node:http";
import * as net from "node:net";

const server = net.createServer((socket) => socket.end("hello"));
server.listen(0, "127.0.0.1", () => {
  const agent = new http.Agent({ keepAlive: true });
  const port = server.address().port;
  console.log("dialer", typeof agent.createConnection);
  const socket = agent.createConnection({ port, host: "127.0.0.1" }, () => {
    console.log("connected");
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    console.log("data", chunk);
    socket.end();
    server.close();
    agent.destroy();
  });
  socket.on("error", (e) => console.log("error", e.code));
});
