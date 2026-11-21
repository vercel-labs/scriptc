/* The module proxy's policy: a configured proxy is used or the request
 * fails, never a silent direct connection; the proxied request target is
 * validated like Node validates it; and error text never carries the proxy
 * URL's credentials. */
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
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-policy-"));
const certs = join(import.meta.dirname, "../fixtures/server/certs");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: import("node:net").Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

type Recorder = { port: number; heads: string[]; cons: import("node:net").Socket[] };

async function recordingProxy(
  answer: (sock: import("node:net").Socket, head: string) => void,
): Promise<Recorder> {
  const heads: string[] = [];
  const cons: import("node:net").Socket[] = [];
  const server = createNetServer((sock) => {
    cons.push(sock);
    sock.once("data", (buf) => {
      const head = buf.toString("utf8");
      heads.push(head.split("\r\n")[0] ?? "");
      answer(sock, head);
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
): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      env: { ...base, ...env },
      timeout: 20000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const f = e as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? "", stderr: f.stderr ?? "" };
  }
}

function okAnswer(body: string) {
  return (sock: import("node:net").Socket) => {
    sock.end(
      `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
    );
  };
}

test("a queued request under global-agent limits still goes through HTTP_PROXY", async () => {
  const proxy = await recordingProxy(okAnswer("prox"));
  const source = `import * as http from "node:http";
http.globalAgent.maxSockets = 1;
http.globalAgent.maxTotalSockets = 1;
const paths = ["/a", "/b"];
const bodies = [];
const done = () => {
  if (bodies.length === paths.length) console.log("bodies", bodies.join(","));
};
for (const path of paths) {
  http.get({ host: "target.invalid", port: 80, path }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => { bodies.push(body); done(); });
  }).on("error", (e) => { console.log("error", e.code); done(); });
}
`;
  const { bin, entry } = await build("queued", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout.trim()).toBe("bodies prox,prox");
  expect([...proxy.heads].sort()).toEqual([
    "GET http://target.invalid/a HTTP/1.1",
    "GET http://target.invalid/a HTTP/1.1",
    "GET http://target.invalid/b HTTP/1.1",
    "GET http://target.invalid/b HTTP/1.1",
  ]);
});

test("the proxied request target requires an origin-form path", async () => {
  const proxy = await recordingProxy(okAnswer("prox"));
  const source = `import * as http from "node:http";
for (const path of ["x", "@evil.example/y", "?q=1"]) {
  try {
    http.get({ host: "target.invalid", port: 80, path }).on("error", () => {});
    console.log("accepted", path);
  } catch (e) {
    const err = e;
    console.log("throw", path, err.code, err.message);
  }
}
`;
  const { bin, entry } = await build("paths", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout).toContain("throw x ERR_INVALID_ARG_VALUE");
  expect(reference.stdout).toContain("must be in absolute-form or start with /");
});

test("a double-slash path keeps the configured authority", async () => {
  const proxy = await recordingProxy(okAnswer("prox"));
  const source = `import * as http from "node:http";
http.get({ host: "target.invalid", port: 80, path: "//evil.example/y" }, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("body", body));
}).on("error", (e) => console.log("error", e.code));
`;
  const { bin, entry } = await build("doubleslash", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout.trim()).toBe("body prox");
  expect(proxy.heads[0]).toBe("GET http://target.invalid//evil.example/y HTTP/1.1");
});

test("an invalid authority is rejected before any dial", async () => {
  const proxy = await recordingProxy(okAnswer("prox"));
  const source = `import * as http from "node:http";
try {
  http.get({ host: "target.invalid\\r\\nX-Evil: 1", port: 80, path: "/x", headers: { host: "ok.example" } }).on("error", () => {});
  console.log("accepted");
} catch (e) {
  console.log("throw", e.code, e.message);
}
`;
  const { bin, entry } = await build("badhost", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout.trim()).toBe("throw ERR_INVALID_URL Invalid URL");
  expect(proxy.heads).toEqual([]);
});

test("a supplied Host header must name the request authority", async () => {
  const proxy = await recordingProxy(okAnswer("prox"));
  const source = `import * as http from "node:http";
try {
  http.get({ host: "target.invalid", port: 80, path: "/x", headers: { host: "other.example" } }).on("error", () => {});
  console.log("accepted");
} catch (e) {
  console.log("throw", e.code, e.message);
}
`;
  const { bin, entry } = await build("badhostheader", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout).toContain("ERR_INVALID_ARG_VALUE");
  expect(proxy.heads).toEqual([]);
});

test("a proxy URL scheme the runtime cannot dial fails closed", async () => {
  const proxy = await recordingProxy(okAnswer("prox"));
  const source = `import * as http from "node:http";
try {
  http.get({ host: "target.invalid", port: 80, path: "/x" }).on("error", (e) => console.log("error", e.code));
  console.log("constructed");
} catch (e) {
  console.log("throw", e.code, e.message);
}
`;
  const { bin } = await build("tlsscheme", source);
  const native = await run(bin, [], {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: `https://127.0.0.1:${proxy.port}`,
  });
  expect(native.stdout).toContain("throw SC2020");
  expect(native.stdout).toContain("not supported yet");
  expect(proxy.cons.length).toBe(0);
});

test("the tunnel error text never carries the proxy credentials", async () => {
  const proxy = await recordingProxy((sock) => {
    sock.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  const source = `import * as https from "node:https";
https.get({ host: "target.invalid", port: 443, path: "/x" }).on("error", (e) => {
  console.log("error", e.code, e.message);
});
`;
  const { bin, entry } = await build("tunnelauth", source);
  const env = {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: `http://user:p%40ss@127.0.0.1:${proxy.port}/`,
  };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(reference.stdout).toContain("ERR_PROXY_TUNNEL");
  expect(reference.stdout).not.toContain("p%40ss");
  expect(reference.stdout).not.toContain("user:");
});

test("a backpressured upload finishes once the tunnel is up", async () => {
  const server = createHttpsServer(
    {
      key: readFileSync(join(certs, "localhost-key.pem")),
      cert: readFileSync(join(certs, "localhost.pem")),
    },
    (req, res) => {
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
      });
      req.on("end", () => res.end(String(bytes)));
    },
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
      // a slow proxy: the CONNECT reply comes long after the upload began
      setTimeout(() => {
        const upstream = connect(Number(m[1]), "127.0.0.1", () => {
          sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.pipe(sock);
          sock.pipe(upstream);
        });
        cons.push(upstream);
      }, 300);
    });
  });
  servers.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as https from "node:https";
const req = https.request({
  host: "127.0.0.1",
  port: ${targetPort},
  path: "/upload",
  method: "POST",
  rejectUnauthorized: false,
}, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("response", body));
});
req.on("error", (e) => console.log("error", e.code));
const chunk = "x".repeat(16384);
for (let i = 0; i < 8; i++) req.write(chunk);
req.end(chunk);
`;
  const { bin, entry } = await build("upload", source);
  const env = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` };
  try {
    const reference = await run(process.execPath, [entry], env);
    const native = await run(bin, [], env);
    expect(native.stdout).toBe(reference.stdout);
    expect(reference.stdout.trim()).toBe("response 147456");
  } finally {
    for (const sock of cons) sock.destroy();
  }
});

test("fetch's resolved proxy is the only one it dials", async () => {
  const httpProxy = await recordingProxy((sock) => {
    sock.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
  });
  const httpsProxy = await recordingProxy(okAnswer("wrong"));
  const source = `const res = await fetch("http://target.invalid/x").then(
  (r) => r.text(),
  (e) => "error " + (e.cause?.code ?? e.message),
);
console.log("fetch", res);
`;
  const { bin, entry } = await build("fetchproxies", source);
  const env = {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: `http://127.0.0.1:${httpProxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${httpsProxy.port}`,
  };
  const reference = await run(process.execPath, [entry], env);
  const native = await run(bin, [], env);
  expect(native.stdout).toBe(reference.stdout);
  expect(httpProxy.heads[0]).toBe("CONNECT target.invalid:80 HTTP/1.1");
  expect(httpsProxy.heads).toEqual([]);
});
