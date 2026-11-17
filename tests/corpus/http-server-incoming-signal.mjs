// IncomingMessage.signal: one AbortSignal per request (repeated reads are the
// same object), not aborted on a clean request, aborted with an AbortError
// when the connection dies before the request completes.
import { createServer } from "node:http";
import { connect } from "node:net";

const server = createServer((req, res) => {
  const signal = req.signal;
  console.log("start", req.url, signal === req.signal, signal.aborted, signal.reason === undefined);
  // An abort listener that tears the request down re-enters destroy: the
  // request must stay alive until the outer call returns.
  signal.addEventListener("abort", () => {
    req.destroy();
  });
  signal.addEventListener("abort", () => {
    const reason = signal.reason;
    console.log("abort event", req.url, signal.aborted, reason?.name, reason?.message, req.aborted);
  });
  if (req.url === "/signal") {
    const key = req.url.slice(1);
    const dynamic = req[key];
    console.log("dynamic key", dynamic === signal, dynamic.aborted);
    res.end("ok");
    return;
  }
  if (req.url === "/self-destroy") {
    req.on("close", () => console.log("close", req.url, req.complete, req.aborted));
    req.destroy();
    console.log("destroyed", signal.aborted);
    return;
  }
  if (req.url === "/destroy") {
    req.on("close", () => console.log("close", req.url, req.complete, req.aborted));
    return;
  }
  res.end("ok");
});

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const run = (path, partial, next) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => {
      if (partial) {
        socket.write(`POST ${path} HTTP/1.1\r\nHost: l\r\nContent-Length: 10\r\n\r\nab`);
        setTimeout(() => socket.destroy(), 50);
      } else {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on("data", () => {});
    socket.on("close", () => setTimeout(next, 20));
  };
  run("/clean", false, () =>
    run("/signal", false, () =>
      run("/self-destroy", true, () =>
        run("/destroy", true, () => server.close(() => console.log("closed"))),
      ),
    ),
  );
});
