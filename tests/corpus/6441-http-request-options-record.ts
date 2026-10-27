// http.request options read at run time: a RequestOptions value chosen by
// a runtime condition (a TCP endpoint with a string port, or a socket
// path), spread into an options object with a timeout and an optional
// signal; agent: false; an aborted signal; a flat [name, value, ...]
// headers array; and Node's validation errors for the method, port, host,
// timeout, path, protocol and agent options and for flat header names and
// values.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  const host = (req.headers.host ?? "").replace(/:\d+$/, ":<port>");
  res.end(`${req.method} ${req.url} host=${host} connection=${req.headers.connection} n=${req.headers["x-n"]}`);
});

function send(label: string, options: http.RequestOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request(options, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      res.on("end", () => {
        console.log(label, res.statusCode, text);
        resolve();
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log(label, "error", err.name, err.code, err.message);
      resolve();
    });
    req.end();
  });
}

function invalid(label: string, options: http.RequestOptions): void {
  try {
    const req = http.request(options);
    req.on("error", () => {});
    req.destroy();
    console.log(label, "accepted");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(label, e.name, e.code, e.message);
  }
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const endpoint = process.env.NO_SUCH_ENDPOINT_VAR ?? `http://127.0.0.1:${port}`;
  const url = new URL(endpoint);
  const location: http.RequestOptions = process.env.NO_SUCH_SOCKET_VAR
    ? { socketPath: process.env.NO_SUCH_SOCKET_VAR }
    : { port: url.port, host: url.hostname };
  const headers: Record<string, string | number> = { "x-n": 1 };
  const controller: AbortController | undefined = undefined;
  const options = { ...location, path: "/rpc", method: "post", headers, timeout: 2000, signal: controller };
  // The flat [name, value, ...] headers form; @types/node types headers as an object.
  const flat = (path: string, list: unknown[]): http.RequestOptions =>
    ({ ...location, path, headers: list }) as unknown as http.RequestOptions;
  await send("spread", options);
  await send("agent false", { ...location, path: "/close", agent: false });
  const aborted = new AbortController();
  aborted.abort();
  await send("aborted", { ...location, path: "/never", signal: aborted.signal });
  await send("flat headers", flat("/flat", ["host", "flat.test", "x-n", 2]));
  invalid("method", { ...location, method: "g t" });
  invalid("port", { host: "127.0.0.1", port: "http" });
  invalid("host", { hostname: 5 } as unknown as http.RequestOptions);
  invalid("timeout", { ...location, timeout: -1 });
  invalid("path", { ...location, path: "/a b" });
  invalid("protocol", { ...location, protocol: "https:" });
  invalid("agent", { ...location, agent: 5 } as unknown as http.RequestOptions);
  invalid("flat name", flat("/", ["x n", "1"]));
  invalid("flat number name", flat("/", [5, "1"]));
  invalid("flat crlf value", flat("/", ["x-a", "ok\r\nx-b: injected"]));
  invalid("flat crlf array value", flat("/", ["x-a", ["ok", "b\r\nx-c: injected"]]));
  invalid("flat odd length", flat("/", ["x-a"]));
  server.close();
});
