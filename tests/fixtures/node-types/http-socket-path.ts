// An HTTP client that reaches its API over a Unix socket unless an
// endpoint URL is configured, typed by @types/node: the location is an
// http.RequestOptions chosen at run time, spread into each request's
// options with a path, method, headers, timeout and an optional signal.
// server.address() answers the socket path (a TCP server's the record), and
// server.close callbacks take Node's ERR_SERVER_NOT_RUNNING error.
import * as http from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const socketPath: string = join(tmpdir(), `scriptc-api-${process.pid}.sock`);
const endpoint = process.env.NO_SUCH_API_ENDPOINT_VAR ? new URL(process.env.NO_SUCH_API_ENDPOINT_VAR) : undefined;
const location: http.RequestOptions = endpoint
  ? { port: endpoint.port, host: endpoint.hostname }
  : { socketPath };

function call(path: string, body: string, timeout: number, ac?: AbortController): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    const options = {
      ...location,
      path,
      method: "POST",
      headers,
      timeout,
      signal: ac?.signal,
    };
    const request = http.request(options, (res) => {
      let data = "";
      res.on("data", (part: Buffer) => {
        data += part.toString();
      });
      res.on("error", reject);
      res.on("end", () => resolve(`${res.statusCode} ${data}`));
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.end(body);
  });
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part: Buffer) => {
    body += part.toString();
  });
  req.on("end", () => {
    res.end(`${req.method} ${req.url} host=${req.headers.host} body=${body}`);
  });
});

function describeAddress(address: string | AddressInfo | null): string {
  if (address === null) return "null";
  return typeof address === "string" ? address.split(socketPath).join("<sock>") : `${address.family} port>0=${address.port > 0}`;
}

server.listen(socketPath, async () => {
  console.log("address", describeAddress(server.address()));
  const tcp = http.createServer();
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", () => resolve()));
  console.log("tcp address", describeAddress(tcp.address()));
  tcp.close();
  console.log(await call("/v1/start", JSON.stringify({ id: 1 }), 5000));
  console.log(await call("/v1/status", JSON.stringify({ id: 2 }), 5000, new AbortController()));
  try {
    const ac = new AbortController();
    ac.abort();
    await call("/v1/never", "{}", 5000, ac);
  } catch (err) {
    console.log("aborted", (err as Error).name);
  }
  server.close((err) => console.log("closed", err === undefined, existsSync(socketPath)));
  server.close((err) => console.log("closed again", err?.name, (err as NodeJS.ErrnoException)?.code, err?.message));
  http.createServer().close((err) => console.log("never listened", (err as NodeJS.ErrnoException)?.code));
});
