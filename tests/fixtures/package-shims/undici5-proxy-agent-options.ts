// Every option of undici 5's ProxyAgent, one value per cell: what the proxy
// receives for the tunnel and how the request ends. The proxy and the
// origins run in this program; the https origins use the test certificates
// of the `tls` directory beside it (an authority made for these tests, and
// certificates for the name origin.test, for localhost and for 127.0.0.1).
// The expected output is undici 5.29.0's under Node 24 wherever the two
// agree, and a refusal that names the option wherever the built-in undici
// does not implement it (package-shims.test.ts counts both).
import { readFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { ProxyAgent, request } from "undici";

const pem = (name: string): string => readFileSync(`tls/${name}`, "utf8");
const ca = pem("ca.pem");

const answer = (label: string) => (req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.end(`${label} ${req.method} ${req.url}`);
};
const origin = http.createServer(answer("origin"));
const named = https.createServer({ key: pem("named.key"), cert: pem("named.pem") }, answer("named"));
const local = https.createServer({ key: pem("local.key"), cert: pem("local.pem") }, answer("local"));
const byAddress = https.createServer({ key: pem("address.key"), cert: pem("address.pem") }, answer("address"));

const seen: string[] = [];
const tunnel = (socket: net.Socket): void => {
  let head = "";
  let tunnelled = false;
  socket.on("data", (chunk: Buffer) => {
    if (tunnelled) return;
    head += chunk.toString("latin1");
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    tunnelled = true;
    for (const line of head.slice(0, end).split("\r\n")) seen.push(line.replace(/:\d{4,5}\b/g, ":PORT"));
    const target = head.split(" ")[1] ?? "";
    const upstream = net.connect(Number(target.slice(target.lastIndexOf(":") + 1)), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  socket.on("error", () => {});
};
const proxy = net.createServer(tunnel);
// The same proxy on the IPv6 loopback address, for a proxy URL that is an IPv6 literal.
const proxy6 = net.createServer(tunnel);

function say(line: string): void {
  console.log(line.replace(/:\d{4,5}\b/g, ":PORT").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\u0000/g, "\\0"));
}

let proxyUri = "";

async function cell(label: string, target: string, make: () => ProxyAgent, wording = true): Promise<void> {
  seen.length = 0;
  let line: string;
  try {
    const agent = make();
    try {
      const res = await request(target, { dispatcher: agent });
      line = `${res.statusCode} ${await res.body.text()}`;
    } finally {
      await agent.close().catch(() => {});
    }
  } catch (err) {
    const error = err as { name?: string; code?: unknown; message?: string };
    line = `threw ${String(error.name)} ${String(error.code ?? "-")}${wording ? `: ${String(error.message)}` : ""}`;
  }
  say(`${label}: ${line} | proxy saw ${seen.length === 0 ? "nothing" : seen.join(" / ")}`);
}

function listen(server: net.Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function main(): Promise<void> {
  const plainPort = await listen(origin);
  const namedPort = await listen(named);
  const localPort = await listen(local);
  const addressPort = await listen(byAddress);
  const proxyPort = await listen(proxy);
  const proxy6Port = await listen(proxy6, "::1");
  proxyUri = `http://127.0.0.1:${proxyPort}`;
  const plain = `http://127.0.0.1:${plainPort}/p`;
  const uri = proxyUri;

  await cell("uri as a string", plain, () => new ProxyAgent(uri));
  await cell("uri in options", plain, () => new ProxyAgent({ uri }));
  await cell("uri with credentials", plain, () => new ProxyAgent(`http://user:pass%20word@127.0.0.1:${proxyPort}`));
  await cell("uri with an IPv6 literal", plain, () => new ProxyAgent(`http://[::1]:${proxy6Port}`));
  await cell("uri socks5", plain, () => new ProxyAgent(`socks5://127.0.0.1:${proxyPort}`));
  await cell("uri empty", plain, () => new ProxyAgent({ uri: "" }));
  await cell("uri not a URL", plain, () => new ProxyAgent({ uri: "not a url" }));

  await cell("token", plain, () => new ProxyAgent({ uri, token: "Bearer abc" }));
  await cell("token with a line break", plain, () => new ProxyAgent({ uri, token: "Bearer abc\r\nx-added: 1" }));
  await cell("token with a line feed", plain, () => new ProxyAgent({ uri, token: "Bearer abc\nx-added: 1" }));
  await cell("token with a NUL", plain, () => new ProxyAgent({ uri, token: "Bearer a\u0000b" }));
  await cell("auth", plain, () => new ProxyAgent({ uri, auth: "dXNlcjpwYXNz" }));
  await cell("auth with a line break", plain, () => new ProxyAgent({ uri, auth: "dXNlcjpwYXNz\r\nx-added: 1" }));
  await cell("auth and token", plain, () => new ProxyAgent({ uri, auth: "a", token: "b" }));

  await cell("header", plain, () => new ProxyAgent({ uri, headers: { "x-trace": "t1" } }));
  await cell("header beside a token", plain, () => new ProxyAgent({ uri, token: "Bearer abc", headers: { "x-trace": "t1", "proxy-authorization": "mine" } }));
  await cell("header with a line break", plain, () => new ProxyAgent({ uri, headers: { "x-trace": "t1\r\nx-added: 2" } }));
  await cell("header name with a line break", plain, () => new ProxyAgent({ uri, headers: { "x-trace: t1\r\nx-added": "2" } }));
  await cell("header name with a space", plain, () => new ProxyAgent({ uri, headers: { "x trace": "t1" } }));
  await cell("header with a list", plain, () => new ProxyAgent({ uri, headers: { "x-trace": ["t1", "t2"] } }));
  await cell("header with a list holding a line break", plain, () => new ProxyAgent({ uri, headers: { "x-trace": ["t1", "t2\r\nx-added: 3"] } }));
  await cell("header latin1", plain, () => new ProxyAgent({ uri, headers: { "x-trace": "café" } }));
  await cell("header beyond latin1", plain, () => new ProxyAgent({ uri, headers: { "x-trace": "€" } }));
  await cell("header connection close", plain, () => new ProxyAgent({ uri, headers: { connection: "close" } }));
  await cell("header connection keep-alive", plain, () => new ProxyAgent({ uri, headers: { connection: "keep-alive" } }));
  await cell("header host", plain, () => new ProxyAgent({ uri, headers: { host: "elsewhere.example" } }));
  await cell("header Host", plain, () => new ProxyAgent({ uri, headers: { Host: "elsewhere.example" } }));
  await cell("header content-length", plain, () => new ProxyAgent({ uri, headers: { "content-length": "5" } }));
  await cell("header content-type", plain, () => new ProxyAgent({ uri, headers: { "content-type": "text/plain" } }));
  await cell("header transfer-encoding", plain, () => new ProxyAgent({ uri, headers: { "transfer-encoding": "chunked" } }));
  await cell("header keep-alive", plain, () => new ProxyAgent({ uri, headers: { "keep-alive": "timeout=5" } }));
  await cell("header upgrade", plain, () => new ProxyAgent({ uri, headers: { upgrade: "h2c" } }));
  await cell("header expect", plain, () => new ProxyAgent({ uri, headers: { expect: "100-continue" } }));

  await cell("requestTls timeout", plain, () => new ProxyAgent({ uri, requestTls: { timeout: 5000 } }));
  await cell("requestTls keepAlive", plain, () => new ProxyAgent({ uri, requestTls: { keepAlive: false } }));
  await cell("requestTls servername, plain origin", plain, () => new ProxyAgent({ uri, requestTls: { servername: "x.example" } }));
  await cell("proxyTls timeout", plain, () => new ProxyAgent({ uri, proxyTls: { timeout: 5000 } }));
  await cell("proxyTls keepAlive", plain, () => new ProxyAgent({ uri, proxyTls: { keepAlive: false } }));
  await cell("proxyTls noDelay", plain, () => new ProxyAgent({ uri, proxyTls: { noDelay: false } }));
  await cell("proxyTls port", plain, () => new ProxyAgent({ uri, proxyTls: { port: 1 } }));
  await cell("proxyTls autoSelectFamily", plain, () => new ProxyAgent({ uri, proxyTls: { autoSelectFamily: true } }));
  await cell("proxyTls maxCachedSessions invalid", plain, () => new ProxyAgent({ uri, proxyTls: { maxCachedSessions: -1 } }));
  await cell("connect option", plain, () => new ProxyAgent({ uri, connect: { rejectUnauthorized: false } }));
  await cell("pool options", plain, () => new ProxyAgent({ uri, connections: 1, pipelining: 1, keepAliveTimeout: 1000 }));
  await cell("clientFactory", plain, () => new ProxyAgent({ uri, clientFactory: () => { throw new Error("never"); } }));

  const namedUrl = `https://origin.test:${namedPort}/s`;
  const localAsNamed = `https://origin.test:${localPort}/s`;
  await cell("tls, the origin's name, ca", namedUrl, () => new ProxyAgent({ uri, requestTls: { ca } }), false);
  await cell("tls, no ca", namedUrl, () => new ProxyAgent({ uri }), false);
  await cell("tls, certificate of another name, ca", localAsNamed, () => new ProxyAgent({ uri, requestTls: { ca } }), false);
  await cell("tls, certificate of another name, servername of that name", localAsNamed, () => new ProxyAgent({ uri, requestTls: { ca, servername: "localhost" } }), false);
  await cell("tls, servername of another name", namedUrl, () => new ProxyAgent({ uri, requestTls: { ca, servername: "localhost" } }), false);
  await cell("tls, rejectUnauthorized false", localAsNamed, () => new ProxyAgent({ uri, requestTls: { rejectUnauthorized: false } }), false);
  await cell("tls, an address, certificate for the address", `https://127.0.0.1:${addressPort}/s`, () => new ProxyAgent({ uri, requestTls: { ca } }), false);
  await cell("tls, an address, certificate of a name", `https://127.0.0.1:${localPort}/s`, () => new ProxyAgent({ uri, requestTls: { ca } }), false);
  // The proxy is at 127.0.0.1: a certificate for that address is not one
  // for the origin's name.
  await cell("tls, certificate of the proxy's address", `https://origin.test:${addressPort}/s`, () => new ProxyAgent({ uri, requestTls: { ca } }), false);
  await cell("tls, localhost", `https://localhost:${localPort}/s`, () => new ProxyAgent({ uri, requestTls: { ca } }), false);
  await cell("tls, empty requestTls", namedUrl, () => new ProxyAgent({ uri, requestTls: {} }), false);

  proxy.close();
  proxy6.close();
  origin.close();
  named.close();
  local.close();
  byAddress.close();
}

void main();
