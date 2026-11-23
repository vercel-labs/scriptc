/* A proxied request that waits for an agent slot keeps its routing: an https
 * request still opens its CONNECT tunnel (never TLS straight to the proxy),
 * and an idle pooled connection never starves a waiting proxied request. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-limited-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function build(name: string, source: string): Promise<string> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("compile failed");
  return result.binaryPath;
}

async function run(bin: string): Promise<{ stdout: string; elapsed: number; stderr: string }> {
  const base = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, [], { env: base, timeout: 20000 });
    return { stdout, elapsed: Date.now() - started, stderr };
  } catch (e) {
    const f = e as { stdout?: string; stderr?: string };
    throw new Error(
      "program failed: out=" + JSON.stringify(f.stdout) + " err=" + JSON.stringify(f.stderr),
    );
  }
}

test("a queued https proxied request still sends its CONNECT", async () => {
  const lines: string[] = [];
  const proxy = createNetServer((sock) => {
    sock.once("data", (buf) => {
      const text = buf.toString("latin1");
      lines.push(text.startsWith("CONNECT ") ? text.split("\r\n")[0]! : "tls-or-other");
      setTimeout(() => {
        sock.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      }, 150);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as http from "node:http";
import * as https from "node:https";
https.globalAgent.maxSockets = 1;
https.globalAgent.maxTotalSockets = 1;
const proxyUrl = "http://127.0.0.1:${proxyPort}";
http.setGlobalProxyFromEnv({ HTTPS_PROXY: proxyUrl });
const first = https.request({ host: "target.invalid", port: 443, path: "/slow" }, (res) => {
  res.resume();
  res.on("end", () => {
    console.log("first", res.statusCode);
  });
});
first.on("error", (e) => console.log("first error", e.code));
first.on("socket", () => {
  https.request({ host: "other.invalid", port: 443, path: "/x" }, (res) => {
    res.resume();
    res.on("end", () => console.log("second", res.statusCode));
  }).on("error", (e) => console.log("second error", e.code));
});
first.end();
`;
  try {
    const bin = await build("tunnel", source);
    const { stdout, stderr } = await run(bin);
    void stderr;
    expect(stdout).toContain("first error ERR_PROXY_TUNNEL");
    expect(JSON.stringify(lines)).toBe(
      JSON.stringify(["CONNECT target.invalid:443 HTTP/1.1", "CONNECT other.invalid:443 HTTP/1.1"]),
    );
  } finally {
    proxy.close();
  }
});

test("an idle pooled connection does not starve a waiting proxied request", async () => {
  const heads: string[] = [];
  const cons: import("node:net").Socket[] = [];
  const proxy = createNetServer((sock) => {
    cons.push(sock);
    sock.once("data", (buf) => {
      const line = buf.toString("utf8").split("\r\n")[0] ?? "";
      heads.push(line);
      // keep the first connection alive in the agent's pool: the response
      // goes out but the proxy does not close its side
      sock.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as http from "node:http";
http.globalAgent.maxSockets = 1;
http.globalAgent.maxTotalSockets = 1;
http.setGlobalProxyFromEnv({ HTTP_PROXY: "http://127.0.0.1:${proxyPort}" });
const first = http.request({ host: "target.invalid", port: 80, path: "/first" }, (res) => {
  res.resume();
  res.on("end", () => {
    console.log("first", res.statusCode);
  });
});
first.on("socket", () => {
  http.request({ host: "other.invalid", port: 80, path: "/second" }, (res) => {
    res.resume();
    res.on("end", () => console.log("second", res.statusCode));
  }).on("error", (e) => console.log("error", e.code)).end();
});
first.end();
`;
  try {
    const bin = await build("starve", source);
    const { stdout, elapsed } = await run(bin);
    expect(stdout).toContain("first 200");
    expect(stdout).toContain("second 200");
    expect(heads).toEqual([
      "GET http://target.invalid/first HTTP/1.1",
      "GET http://other.invalid/second HTTP/1.1",
    ]);
    expect(elapsed).toBeLessThan(2500);
  } finally {
    for (const sock of cons) sock.destroy();
    proxy.close();
  }
});
