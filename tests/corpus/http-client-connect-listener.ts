// A 'connect' or 'upgrade' listener registered with on() reads its request
// inside the callback. The request closes once the tunnel's or the upgraded
// socket goes away; the listener list goes with it, so the closure stops
// holding the request and the objects the request reaches are freed.
import * as http from "node:http";
import * as net from "node:net";

function tunnelPeer(): net.Server {
  return net.createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.indexOf("\r\n\r\n") < 0) return;
      text = "";
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    socket.on("error", () => {});
  });
}

await new Promise<void>((resolve) => {
  const server = tunnelPeer();
  server.listen(0, "127.0.0.1", () => {
    const request = http.request({
      port: (server.address() as net.AddressInfo).port,
      host: "127.0.0.1",
      method: "CONNECT",
      path: "listener.test:443",
      agent: false,
    });
    request.on("connect", (response, socket) => {
      // Reading the request here makes the listener's closure hold it.
      console.log("connect", response.statusCode, response.statusMessage, request.destroyed);
      socket.destroy();
    });
    request.on("close", () => {
      console.log("close", request.destroyed);
      server.close(() => resolve());
    });
    request.end();
  });
});

await new Promise<void>((resolve) => {
  let peer: net.Socket | null = null;
  const server = http.createServer((_request, response) => {
    response.end("no");
  });
  server.on("upgrade", (_request: http.IncomingMessage, socket: net.Socket) => {
    peer = socket;
    socket.on("error", () => {});
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
  });
  server.listen(0, "127.0.0.1", () => {
    const request = http.request({
      port: (server.address() as net.AddressInfo).port,
      host: "127.0.0.1",
      headers: { connection: "Upgrade", upgrade: "test" },
      agent: false,
    });
    request.on("upgrade", (response, socket, head) => {
      console.log("upgrade", response.statusCode, response.statusMessage, request.destroyed, head.length);
      socket.destroy();
    });
    request.on("close", () => {
      console.log("close", request.destroyed);
      peer?.destroy();
      server.close(() => resolve());
    });
    request.end();
  });
});
