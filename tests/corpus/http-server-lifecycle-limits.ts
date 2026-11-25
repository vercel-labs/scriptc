import { createServer } from "node:http";
import { connect } from "node:net";

type Server = ReturnType<typeof createServer>;
type Socket = ReturnType<typeof connect>;

function addressPort(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

const listener = createServer();
listener.on("listening", () => console.log("listening event", listener.listening));
listener.on("close", () => console.log("close event", listener.listening));
listener.listen(0, "127.0.0.1", () => {
  const address = listener.address();
  console.log(
    "listening cb",
    listener.listening,
    typeof address === "object" && address !== null && address.port > 0,
    typeof address === "object" && address !== null ? address.address : "",
    typeof address === "object" && address !== null ? address.family : "",
  );
  listener.close(() => {
    console.log("close cb", listener.listening);
    phaseTimeout();
  });
});

function phaseTimeout(): void {
  const server = createServer((_req, res) => res.end("unused"));
  server.on("timeout", (socket: Socket) => {
    console.log("timeout event", socket.remoteAddress !== undefined);
    socket.destroy();
  });
  server.setTimeout(50);
  server.listen(0, "127.0.0.1", () => {
    const socket = connect(addressPort(server), "127.0.0.1");
    socket.on("connect", () => console.log("timeout client connected"));
    socket.on("data", () => {});
    socket.on("close", () => {
      console.log("timeout socket closed");
      server.close(phaseMaxRequests);
    });
  });
}

function phaseMaxRequests(): void {
  const server = createServer((req, res) => res.end(String(req.url)));
  server.maxRequestsPerSocket = 1;
  server.on("dropRequest", (req, _socket) => console.log("dropRequest", req.method, req.url));
  server.listen(0, "127.0.0.1", () => {
    const socket = connect(addressPort(server), "127.0.0.1");
    let wire = "";
    let second = false;
    socket.on("connect", () => socket.write("GET /one HTTP/1.1\r\nHost: l\r\n\r\n"));
    socket.on("data", (chunk: Buffer) => {
      wire += chunk.toString("latin1");
      if (!second && wire.includes("/one")) {
        second = true;
        socket.write("GET /two HTTP/1.1\r\nHost: l\r\n\r\n");
      }
    });
    socket.on("close", () => {
      console.log("maxRequests close", wire.includes("503"), wire.includes("/one"));
      server.close(phaseCloseIdle);
    });
  });
}

function phaseCloseIdle(): void {
  const server = createServer((_req, res) => res.end("idle"));
  server.listen(0, "127.0.0.1", () => {
    const socket = connect(addressPort(server), "127.0.0.1");
    let wire = "";
    socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: l\r\nConnection: keep-alive\r\n\r\n"));
    socket.on("data", (chunk: Buffer) => {
      wire += chunk.toString("latin1");
      if (wire.includes("idle")) server.closeIdleConnections();
    });
    socket.on("close", () => {
      console.log("idle closed", wire.includes("idle"));
      server.close(phaseCloseAll);
    });
  });
}

function phaseCloseAll(): void {
  const server = createServer(() => {
    console.log("closeAll active");
    server.closeAllConnections();
    server.close(() => console.log("done"));
  });
  server.listen(0, "127.0.0.1", () => {
    const socket = connect(addressPort(server), "127.0.0.1");
    socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: l\r\n\r\n"));
    socket.on("error", () => {});
    socket.on("close", () => console.log("closeAll client closed"));
  });
}
