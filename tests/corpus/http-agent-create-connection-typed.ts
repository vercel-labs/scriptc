// agent.createConnection(options[, callback]) from TYPED code: Node's default
// dialer is net.createConnection, so the typed call dials the same connection
// and hands back a usable Socket.
import * as http from "node:http";
import * as net from "node:net";
import type { Socket } from "node:net";

const server = net.createServer((socket) => socket.end("hello"));
server.listen(0, "127.0.0.1", () => {
  const agent = new http.Agent({ keepAlive: true });
  const port = (server.address() as { port: number }).port;
  console.log("dialer", typeof agent.createConnection);
  // the receiver is evaluated once, before the arguments, as Node does
  let receivers = 0;
  const pick = (): http.Agent => {
    receivers++;
    return agent;
  };
  const socket: Socket = pick().createConnection({ port, host: "127.0.0.1" }, () => {
    console.log("connected");
  });
  console.log("receivers", receivers);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    console.log("data", chunk);
    socket.end();
    server.close();
    agent.destroy();
  });
  socket.on("error", (e) => console.log("error", (e as NodeJS.ErrnoException).code));
});
