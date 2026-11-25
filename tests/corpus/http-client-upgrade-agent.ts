// The 'upgrade' handover takes the socket out of the agent the same way a
// CONNECT response does: inside the listener agent.sockets and
// agent.totalSocketCount do not name the handed-over socket, and the slot it
// held is free for the next request.
import * as http from "node:http";
import * as net from "node:net";

const peer = net.createServer((socket) => {
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk.toString();
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = text.slice(0, end).split("\r\n");
    console.log(
      "peer head",
      JSON.stringify(head[0] ?? ""),
      JSON.stringify(head.find((line) => line.toLowerCase().startsWith("upgrade:")) ?? null),
    );
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const req = http.request({
    port,
    host: "127.0.0.1",
    path: "/socket",
    agent,
    headers: { Connection: "Upgrade", Upgrade: "websocket" },
  });
  req.on("response", () => console.log("response (never)"));
  req.on("upgrade", (res: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    console.log(
      "upgrade",
      res.statusCode,
      head.length,
      req.socket === socket,
      Object.keys(agent.sockets).length,
      agent.totalSocketCount,
    );
    socket.destroy();
    setTimeout(() => {
      console.log("after", Object.keys(agent.sockets).length, agent.totalSocketCount);
      agent.destroy();
      peer.close();
    }, 10);
  });
  req.end();
});
