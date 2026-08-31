/* http.Server inherits net.Server.listen({ reusePort: true }) through the
 * shared server handle. Fresh requests must reach both HTTP listeners on
 * supported platforms; unsupported platforms report the same stable error
 * code shape as Node. */
import { createServer } from "node:http";
import { get } from "node:http";

const host = "127.0.0.1";
const wanted = 64;
let receivedA = 0;
let receivedB = 0;
let completed = 0;
let finished = false;

const first = createServer((_req, res) => {
  receivedA++;
  res.end("a");
});
const second = createServer((_req, res) => {
  receivedB++;
  res.end("b");
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

function requestOne(port: number): void {
  const request = get({ hostname: host, port, path: "/" }, (response) => {
    response.on("data", () => {});
    response.on("end", () => {
      completed++;
      if (completed === wanted) finish();
    });
  });
  request.on("error", () => {});
}

function requestMany(port: number): void {
  for (let i = 0; i < wanted; i++) requestOne(port);
}

first.on("error", (error) => {
  if (finished) return;
  finished = true;
  if (isUnsupported(error)) console.log("unsupported true");
  else console.log("unexpected true error");
});

second.on("error", (error) => {
  if (finished) return;
  finished = true;
  first.close(() => console.log(isUnsupported(error) ? "unsupported true" : "unexpected true error"));
});

first.listen({ port: 0, host, reusePort: true }, () => {
  const address = first.address();
  if (address === null || typeof address === "string") {
    console.log("unexpected address");
    return;
  }
  second.listen({ port: address.port, host, reusePort: true }, () => {
    requestMany(address.port);
  });
});
