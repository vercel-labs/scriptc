import { createServer } from "node:http";
import { connect } from "node:net";
const server = createServer((req, res) => {
  const signal: AbortSignal = req.signal;
  console.log("signal", signal === req.signal, signal.aborted, signal.reason === undefined);
  // An abort listener that tears the request down re-enters destroy: the
  // request must stay alive until the outer call returns.
  signal.addEventListener("abort", () => {
    req.destroy();
  });
  signal.addEventListener("abort", () => {
    const reason = signal.reason as { name?: string };
    console.log("abort", signal.aborted, reason.name);
  });
  if (req.url === "/destroy") {
    req.destroy();
    console.log("destroyed", signal.aborted);
    return;
  }
  res.end("ok");
});
server.listen(0, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const run = (path: string, next: () => void): void => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n`));
    socket.on("data", () => {});
    socket.on("close", () => setTimeout(next, 20));
  };
  run("/clean", () => run("/destroy", () => server.close(() => console.log("closed"))));
});
