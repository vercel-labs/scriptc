// ProxyAgent through the undici 5.x profile: every request travels through
// an HTTP CONNECT tunnel. A small proxy in this process records what it
// was sent and pipes the tunnel to the target, so the output shows the
// CONNECT request as undici 5.29 writes it (ports are masked: they change
// from run to run).
import * as http from "node:http";
import * as net from "node:net";
import { ProxyAgent, errors, fetch, getGlobalDispatcher, request, setGlobalDispatcher } from "undici";

let targetPort = 0;
let proxyPort = 0;
const mask = (text: string): string =>
  text.split(`:${targetPort}`).join(":<target>").split(`:${proxyPort}`).join(":<proxy>");

const target = http.createServer((req, res) => {
  res.setHeader("content-type", "text/plain");
  res.end(`${req.method} ${req.url} host=${mask(req.headers.host ?? "-")} x=${String(req.headers["x-test"] ?? "-")}`);
});

const seen: string[] = [];
let deny = 0;
const proxy = net.createServer((client) => {
  let head: Buffer = Buffer.alloc(0);
  let connected = false;
  const onData = (chunk: Buffer): void => {
    if (connected) return;
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    connected = true;
    const lines = head.subarray(0, end).toString("latin1").split("\r\n");
    seen.push(lines.map(mask).join(" | "));
    if (deny !== 0) {
      client.end(`HTTP/1.1 ${deny} Refused\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
    const address = (lines[0] ?? "").split(" ")[1] ?? "";
    const upstream = net.connect(Number(address.slice(address.lastIndexOf(":") + 1)), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  };
  client.on("data", onData);
  client.on("error", () => {});
});

const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

const describe = (err: unknown): string =>
  err instanceof errors.UndiciError
    ? `${err.name} ${err.code} ${err.message}`
    : err instanceof Error
      ? `${err.name} ${err.message}`
      : String(err);

async function main(): Promise<void> {
  targetPort = await listen(target);
  proxyPort = await listen(proxy);
  const origin = `http://127.0.0.1:${targetPort}`;
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;

  // A string URI; two requests share one tunnel.
  const plain = new ProxyAgent(proxyUrl);
  console.log(plain instanceof ProxyAgent, plain.closed, plain.destroyed);
  for (const path of ["/one", "/two"]) {
    const res = await request(`${origin}${path}`, { dispatcher: plain, headers: { "x-test": "a" } });
    console.log(res.statusCode, await res.body.text());
  }
  console.log(seen.length, seen.join(" || "));
  seen.length = 0;

  // POST with a body, and fetch through the same agent.
  const posted = await request(`${origin}/post`, { dispatcher: plain, method: "POST", body: "payload" });
  console.log(posted.statusCode, await posted.body.text());
  const fetched = await fetch(`${origin}/fetched`, { dispatcher: plain, headers: { "x-test": "f" } });
  console.log(fetched.status, await fetched.text(), seen.length);
  await plain.close();
  console.log(plain.closed, plain.destroyed);

  // A token and extra headers for the proxy; credentials in the URI.
  const withToken = new ProxyAgent({ uri: proxyUrl, token: "Bearer secret", headers: { "x-via": "fixture" } });
  const tokenRes = await request(`${origin}/token`, { dispatcher: withToken });
  console.log(tokenRes.statusCode, await tokenRes.body.text());
  await withToken.close();
  const withUser = new ProxyAgent(`http://user:pa%20ss@127.0.0.1:${proxyPort}`);
  const userRes = await request(`${origin}/user`, { dispatcher: withUser });
  console.log(userRes.statusCode, await userRes.body.text());
  await withUser.close();
  const withAuth = new ProxyAgent({ uri: proxyUrl, auth: "dXNlcjpwYXNz" });
  const authRes = await request(`${origin}/auth`, { dispatcher: withAuth });
  console.log(authRes.statusCode, await authRes.body.text());
  await withAuth.close();
  console.log(seen.join(" || "));
  seen.length = 0;

  // The global dispatcher.
  const before = getGlobalDispatcher();
  const global = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(global);
  const viaGlobal = await request(`${origin}/global`);
  console.log(viaGlobal.statusCode, await viaGlobal.body.text(), getGlobalDispatcher() === global, seen.length);
  setGlobalDispatcher(before);
  await global.close();
  seen.length = 0;

  // A proxy that refuses the tunnel.
  deny = 407;
  const refused = new ProxyAgent(proxyUrl);
  try {
    await request(`${origin}/refused`, { dispatcher: refused });
    console.log("no error");
  } catch (err) {
    console.log(describe(err));
  }
  try {
    await fetch(`${origin}/refused`, { dispatcher: refused });
    console.log("no error");
  } catch (err) {
    console.log(describe(err), "cause:", describe((err as Error).cause));
  }
  await refused.destroy();
  console.log(refused.destroyed, seen.length);
  deny = 0;

  // What the constructor and dispatch refuse.
  const attempts: (() => unknown)[] = [
    () => new ProxyAgent({ uri: "" }),
    () => new ProxyAgent({ uri: proxyUrl, auth: "a", token: "b" }),
    () => new ProxyAgent("not a url"),
  ];
  for (const attempt of attempts) {
    try {
      attempt();
      console.log("no error");
    } catch (err) {
      console.log(describe(err));
    }
  }
  const strict = new ProxyAgent(proxyUrl);
  try {
    await request(`${origin}/x`, { dispatcher: strict, headers: { "Proxy-Authorization": "Basic x" } });
    console.log("no error");
  } catch (err) {
    console.log(describe(err));
  }
  await strict.close();

  target.close();
  proxy.close();
}

main();
