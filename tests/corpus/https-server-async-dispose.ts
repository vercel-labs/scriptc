// https.Server re-exports http.Server, so [Symbol.asyncDispose]() is the
// same promisified close behind TLS: resolve at 'close', reject with
// ERR_SERVER_NOT_RUNNING once the server is no longer running.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

function codeOf(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  return `${e.name} ${e.code} ${e.message}`;
}

const server = https.createServer({ cert, key }, (_req, res) => res.end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log("listening", server.listening, (server.address() as net.AddressInfo).port > 0);
const settled = await server[Symbol.asyncDispose]();
console.log("resolved", settled, "listening", server.listening);
try {
  await server[Symbol.asyncDispose]();
  console.log("second resolved");
} catch (error) {
  console.log("second rejected", codeOf(error));
}

const idle = https.createServer({ cert, key }, (_req, res) => res.end());
try {
  await idle[Symbol.asyncDispose]();
  console.log("idle resolved");
} catch (error) {
  console.log("idle rejected", codeOf(error));
}
console.log("done");
