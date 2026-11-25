// A CONNECT response hands the socket to the 'connect' listener, so the
// socket is no longer the agent's: inside the listener agent.sockets and
// agent.totalSocketCount do not name it, and its maxSockets slot is free for
// the next request — a second tunnel through the same agent dials at once
// instead of waiting for the first one to close.
import * as http from "node:http";
import * as net from "node:net";

const peer = net.createServer((socket) => {
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk.toString();
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) return;
    console.log("peer head", JSON.stringify(text.slice(0, end).split("\r\n")[0] ?? ""));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  socket.on("end", () => socket.end());
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const state = (tag: string): void =>
    console.log(tag, Object.keys(agent.sockets).length, agent.totalSocketCount);
  let tunnels = 0;
  const sockets: net.Socket[] = [];
  const connect = (path: string, next: () => void): void => {
    const req = http.request({ port, host: "127.0.0.1", method: "CONNECT", path, agent });
    req.on("response", () => console.log("response (never)"));
    req.on("connect", (res: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      tunnels += 1;
      console.log(
        "connect",
        tunnels,
        res.statusCode,
        res.httpVersion,
        head.length,
        req.socket === socket,
      );
      state("agent");
      sockets.push(socket);
      next();
    });
    req.end();
  };
  connect("first.test:443", () => {
    // the first tunnel is still open: the agent's only slot is free again
    connect("second.test:443", () => {
      setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        setTimeout(() => {
          state("after");
          agent.destroy();
          peer.close();
        }, 10);
      }, 10);
    });
  });
});
