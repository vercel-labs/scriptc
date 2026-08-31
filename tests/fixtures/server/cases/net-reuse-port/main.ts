/* Node's net.Server.listen({ reusePort: true }) contract. Linux and the
 * other supported Unix targets bind two listeners to one IPv4 endpoint and
 * distribute fresh connections between them. Unsupported targets report the
 * stable Node error-code shape instead; no platform silently degrades to a
 * single listener. */
import { connect, createServer } from "node:net";

const host = "127.0.0.1";
const wanted = 128;
let receivedA = 0;
let receivedB = 0;
let completed = 0;
let finished = false;

const first = createServer((socket) => {
  receivedA++;
  socket.end();
});
const second = createServer((socket) => {
  receivedB++;
  socket.end();
});

function isUnsupported(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function closeBoth(done: () => void): void {
  first.close(() => second.close(done));
}

function finish(): void {
  if (finished) return;
  finished = true;
  closeBoth(() => console.log(receivedA > 0 && receivedB > 0 ? "distributed" : "not distributed"));
}

function openOne(port: number): void {
  const socket = connect(port, host);
  // Consume the server's FIN so the native socket arms its read side just
  // as Node does for a socket with no application payload.
  socket.on("data", () => {});
  socket.on("error", () => {
  });
  socket.on("close", () => {
    completed++;
    if (completed === wanted) finish();
  });
}

function openMany(port: number): void {
  for (let i = 0; i < wanted; i++) openOne(port);
}

first.on("error", (error) => {
  if (finished) return;
  if (isUnsupported(error)) {
    finished = true;
    console.log("unsupported true");
  } else {
    console.log("unexpected true error");
    finished = true;
  }
});

second.on("error", (error) => {
  if (finished) return;
  if (isUnsupported(error)) {
    finished = true;
    first.close(() => console.log("unsupported true"));
  } else {
    finished = true;
    first.close(() => console.log("unexpected true error"));
  }
});

first.listen({ port: 0, host, reusePort: true }, () => {
  const address = first.address();
  if (address === null || typeof address === "string") {
    console.log("unexpected address");
    return;
  }
  second.listen({ port: address.port, host, reusePort: true }, () => {
    openMany(address.port);
  });
});
