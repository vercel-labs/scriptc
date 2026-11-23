/* NODE_USE_ENV_PROXY=1 starts the program with the module's proxy taken from
 * the process environment: plain-http and https requests (and fetch's own
 * client) go through HTTP_PROXY/HTTPS_PROXY without setGlobalProxyFromEnv,
 * while an explicit setGlobalProxyFromEnv object still wins. */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-env-proxy-"));
const certs = join(import.meta.dirname, "../fixtures/server/certs");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: import("node:net").Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function recordingProxy(
  onHead: (head: string, sock: import("node:net").Socket) => void,
): Promise<{ port: number; heads: string[]; cons: import("node:net").Socket[] }> {
  const heads: string[] = [];
  const cons: import("node:net").Socket[] = [];
  const server = createNetServer((sock) => {
    cons.push(sock);
    sock.once("data", (buf) => {
      const head = buf.toString("utf8");
      heads.push(head.split("\r\n")[0] ?? "");
      onHead(head, sock);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, heads, cons };
}

async function build(name: string, source: string): Promise<{ bin: string; entry: string }> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("compile failed");
  return { bin: result.binaryPath, entry };
}

async function run(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  const base = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  try {
    const { stdout } = await execFileAsync(file, args, {
      env: { ...base, ...env },
      timeout: 20000,
    });
    return { code: 0, stdout };
  } catch (e) {
    const f = e as { code?: number; stdout?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? "" };
  }
}

test("NODE_USE_ENV_PROXY sends a plain-http request through HTTP_PROXY", async () => {
  const proxy = await recordingProxy((_head, sock) => {
    sock.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nprox");
  });
  const source = `import * as http from "node:http";
http.get("http://target.invalid/x", (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("body", body));
}).on("error", (e) => console.log("error", e.code));
`;
  const { bin, entry } = await build("plain", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout.trim()).toBe("body prox");
  expect(proxy.heads).toEqual([
    "GET http://target.invalid/x HTTP/1.1",
    "GET http://target.invalid/x HTTP/1.1",
  ]);
});

test("NODE_USE_ENV_PROXY tunnels an https request through HTTPS_PROXY", async () => {
  const server = createHttpsServer(
    {
      key: readFileSync(join(certs, "localhost-key.pem")),
      cert: readFileSync(join(certs, "localhost.pem")),
    },
    (_req, res) => res.end("tunnel-ok"),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const targetPort = (server.address() as { port: number }).port;
  const cons: import("node:net").Socket[] = [];
  const proxy = createNetServer((sock) => {
    sock.once("data", (buf) => {
      const line = buf.toString("utf8").split("\r\n")[0] ?? "";
      const m = /^CONNECT 127\.0\.0\.1:(\d+) HTTP\/1\.1$/.exec(line);
      if (m === null) {
        sock.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      const upstream = connect(Number(m[1]), "127.0.0.1", () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(sock);
        sock.pipe(upstream);
      });
      cons.push(upstream);
    });
  });
  servers.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as https from "node:https";
https.get({ host: "127.0.0.1", port: ${targetPort}, path: "/", rejectUnauthorized: false }, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("body", body));
}).on("error", (e) => console.log("error", e.code));
`;
  try {
    const { bin, entry } = await build("https", source);
    const env = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` };
    const reference = await run(process.execPath, [entry], env);
    const native = await run(bin, [], env);
    expect(native.stdout).toBe(reference.stdout);
    expect(reference.stdout.trim()).toBe("body tunnel-ok");
  } finally {
    for (const sock of cons) sock.destroy();
  }
});

test("an explicit setGlobalProxyFromEnv object wins over the startup switch", async () => {
  const fromEnv = await recordingProxy((_head, sock) => {
    sock.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nprox");
  });
  const explicit = await recordingProxy((_head, sock) => {
    sock.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nprox");
  });
  const source = `import * as http from "node:http";
http.setGlobalProxyFromEnv({ HTTP_PROXY: "http://127.0.0.1:${explicit.port}" });
http.get("http://target.invalid/x", (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("body", body));
}).on("error", (e) => console.log("error", e.code));
`;
  const { bin, entry } = await build("explicit", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${fromEnv.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout.trim()).toBe("body prox");
  expect(fromEnv.heads).toEqual([]);
  expect(explicit.heads).toEqual([
    "GET http://target.invalid/x HTTP/1.1",
    "GET http://target.invalid/x HTTP/1.1",
  ]);
});

test("NODE_USE_ENV_PROXY applies to fetch's own client too", async () => {
  const proxy = await recordingProxy((_head, sock) => {
    sock.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  const source = `const res = await fetch("http://target.invalid/x").then(
  (r) => r.text(),
  (e) => "error " + (e.cause?.code ?? e.message),
);
console.log("fetch", res);
`;
  const { bin, entry } = await build("fetch", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(proxy.heads).toEqual([
    "CONNECT target.invalid:80 HTTP/1.1",
    "CONNECT target.invalid:80 HTTP/1.1",
  ]);
});
