// Options derived from RequestInit under @types/node: an interface that
// extends Omit<RequestInit, ...> holds fetch's BodyInit and HeadersInit
// members, which are destructured, narrowed and passed back into fetch,
// with the remaining members carried as an Omit<...> of RequestInit.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

type PassthroughRequestInit = Omit<RequestInit, "signal" | "redirect" | "dispatcher">;
type FetchBody = NonNullable<RequestInit["body"]>;

interface PostOptions extends PassthroughRequestInit {
  timeoutMs?: number;
}

function describe(body: FetchBody | null | undefined): string {
  return typeof body === "string" ? `text(${body.length})` : body == null ? "none" : "binary or form";
}

async function send(params: {
  port: number;
  method: string;
  body: FetchBody | null | undefined;
  headers: RequestInit["headers"];
  init: Omit<PassthroughRequestInit, "body" | "headers" | "method">;
  timeoutMs: number;
}): Promise<Response> {
  const { port, method, body, headers, init, timeoutMs } = params;
  const fetchInit: RequestInit = {
    ...init,
    method,
    headers,
    body: body ?? undefined,
    signal: AbortSignal.timeout(timeoutMs),
  };
  return fetch(`http://127.0.0.1:${port}/`, fetchInit);
}

async function post(port: number, options: PostOptions = {}): Promise<string> {
  const { timeoutMs, body, method, headers, ...rest } = options;
  const res = await send({
    port,
    method: method ?? "POST",
    body,
    headers,
    init: rest,
    timeoutMs: timeoutMs ?? 5000,
  });
  return `${describe(body)} -> ${res.status} ${await res.text()}`;
}

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (chunk: Buffer) => {
    data += chunk.toString();
  });
  req.on("end", () => {
    res.end(`${req.method} type=${req.headers["content-type"]} x=${req.headers["x-n"]} body=${data}`);
  });
});

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as AddressInfo).port;
  console.log(await post(port, { body: "plain", headers: { "x-n": "1" } }));
  console.log(await post(port, { body: new URLSearchParams("a=1&b=2"), headers: [["x-n", "2"]] }));
  console.log(await post(port, { body: Buffer.from("bytes"), method: "PUT", timeoutMs: 2000 }));
  console.log(await post(port, { method: "DELETE", headers: new Headers({ "x-n": "4" }) }));
  server.close();
});
