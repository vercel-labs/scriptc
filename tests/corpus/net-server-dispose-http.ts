// http.Server and https.Server inherit net.Server's [Symbol.asyncDispose]:
// the same promisified close, so disposal stops accepting at once, settles
// an idle keep-alive connection, and waits for a request in flight before
// the promise fulfills. `await using` reaches the same path through the
// inherited member.
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

// An http server with a request in flight: the response finishes first.
{
  let received!: () => void;
  const started = new Promise<void>((resolve) => (received = resolve));
  const server = http.createServer((request, response) => {
    received();
    setTimeout(() => response.end("slow"), 30);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const slow = new Promise<string>((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () => resolve(body));
    });
    request.on("error", (error: NodeJS.ErrnoException) => resolve(`error ${error.code}`));
  });
  console.log("http listening", server.listening);
  await started;
  const disposing = server[Symbol.asyncDispose]();
  console.log("http body", await slow);
  await disposing;
  console.log("http disposed", server.listening);
}

// An idle keep-alive connection does not hold the close open.
{
  const server = http.createServer((request, response) => response.end("keepalive"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", agent }, (response) => {
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("error", () => resolve());
  });
  await server[Symbol.asyncDispose]();
  agent.destroy();
  console.log("keepalive disposed", server.listening);
}

// `await using` on an http server closes at the block's end.
{
  await using server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  console.log("using listening", server.listening);
}
console.log("using closed");

// https inherits the member through tls.Server.
{
  const server = https.createServer({ key, cert }, (request, response) => response.end("secure"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const body = await new Promise<string>((resolve) => {
    const request = https.get(
      { host: "127.0.0.1", port, path: "/", rejectUnauthorized: false },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () => resolve(text));
      },
    );
    request.on("error", (error: NodeJS.ErrnoException) => resolve(`error ${error.code}`));
  });
  console.log("https body", body);
  await server[Symbol.asyncDispose]();
  console.log("https disposed", server.listening);
}
