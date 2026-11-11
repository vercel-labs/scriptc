// server[Symbol.asyncDispose]() is Node's promisified close(): the promise
// settles at the 'close' event, and a server that was not running rejects
// with ERR_SERVER_NOT_RUNNING.
import * as http from "node:http";
import * as net from "node:net";

function codeOf(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return `${e.name} ${e.code} ${e.message}`;
}

// A running server: listening stops at the call, the promise resolves at
// 'close', and the program's listener runs in registration order.
const server = http.createServer((_req, res) => res.end("ok"));
server.once("close", () => console.log("event close"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log("listening", server.listening);

const pending = server[Symbol.asyncDispose]();
console.log("called listening", server.listening);
const settled = await pending;
console.log("resolved", settled, "listening", server.listening);

// The same server again: it is not running, so close() reports the error.
try {
  await server[Symbol.asyncDispose]();
  console.log("second resolved");
} catch (error) {
  console.log("second rejected", codeOf(error));
}

// A server that never listened rejects the same way, and still emits
// 'close' (Node's close() emits it even without a handle).
const idle = http.createServer((_req, res) => res.end());
idle.once("close", () => console.log("idle close"));
try {
  await idle[Symbol.asyncDispose]();
  console.log("idle resolved");
} catch (error) {
  console.log("idle rejected", codeOf(error));
}

// A server closed with close(cb) before the dispose rejects as well.
const closed = http.createServer((_req, res) => res.end());
await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => closed.close(() => resolve()));
try {
  await closed[Symbol.asyncDispose]();
  console.log("closed resolved");
} catch (error) {
  console.log("closed rejected", codeOf(error));
}
console.log("done");
