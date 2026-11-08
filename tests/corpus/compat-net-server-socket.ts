// net.Server and net.Socket over a loopback connection: the server's
// 'listening', 'connection' and 'close' events with its state and
// connection count, the socket's 'connect', 'data', 'end' and 'close'
// events with its address, byte-count and state properties, the keep-alive
// and no-delay setters, and the 'error' a refused connection reports.
// Which of the server's 'connection' and the client's 'connect' comes first
// over loopback is the event loop's choice, so the program reports both
// once both have happened.
import { connect, createServer, type AddressInfo } from "node:net";

const server = createServer((socket) => {
  socket.on("data", (data) => {
    socket.end("echo:" + data.toString());
  });
});
server.on("close", () => {
  console.log("server close", server.listening);
  refused();
});
server.on("listening", () => {
  const port = (server.address() as AddressInfo).port;
  console.log("listening", server.listening, port > 0, typeof server.maxConnections);
  server.unref();
  server.ref();
  const client = connect(port, "127.0.0.1");
  console.log("connecting", client.connecting, client.readyState);
  client.setNoDelay(true);
  client.setKeepAlive(true, 1000);
  let accepted = false;
  let connected = false;
  const established = (): void => {
    if (!accepted || !connected) return;
    console.log("connection");
    console.log("connect", client.remoteAddress, typeof client.remotePort, typeof client.localPort);
    console.log(client.readyState, client.connecting, client.destroyed);
    server.getConnections((error, count) => {
      console.log("connections", error, count);
      client.write("hi");
    });
  };
  server.on("connection", () => {
    accepted = true;
    established();
  });
  client.on("connect", () => {
    connected = true;
    established();
  });
  client.on("data", (data) => console.log("data", data.toString()));
  client.on("end", () => console.log("end"));
  client.on("close", (hadError) => {
    console.log("close", hadError, client.bytesRead, client.bytesWritten, client.destroyed);
    server.close();
  });
});
server.listen(0, "127.0.0.1");

// Nothing listens on the port a closed server just released.
function refused(): void {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = (probe.address() as AddressInfo).port;
    probe.close(() => {
      const client = connect(port, "127.0.0.1");
      client.on("error", (error) => {
        const err = error as Error & { code?: string; syscall?: string };
        console.log("error", err.code, err.syscall, client.destroyed);
      });
      client.on("close", (hadError) => console.log("close", hadError));
    });
  });
}
