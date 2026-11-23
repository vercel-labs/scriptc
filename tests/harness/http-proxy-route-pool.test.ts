/* Proxy routing never outranks an explicit Unix socket, and a connection
 * made for the proxy never carries a later direct request. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-route-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function build(name: string, source: string): Promise<{ bin: string; entry: string }> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("compile failed");
  return { bin: result.binaryPath, entry };
}

async function run(file: string, args: string[]): Promise<string> {
  const base = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  try {
    const { stdout } = await execFileAsync(file, args, { env: base, timeout: 20000 });
    return stdout;
  } catch (e) {
    const f = e as { stdout?: string; stderr?: string };
    throw new Error(
      "program failed: out=" + JSON.stringify(f.stdout) + " err=" + JSON.stringify(f.stderr),
    );
  }
}

test("a pooled proxied connection never carries a later direct request", async () => {
  const originHeads: string[] = [];
  const origin = createHttpServer((req, res) => {
    originHeads.push(`${req.method} ${req.url}`);
    res.end("direct");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as { port: number }).port;
  const proxyHeads: string[] = [];
  const cons: import("node:net").Socket[] = [];
  const proxy = createNetServer((sock) => {
    cons.push(sock);
    sock.once("data", (buf) => {
      proxyHeads.push(buf.toString("utf8").split("\r\n")[0] ?? "");
      // keep the connection alive so the agent pools it
      sock.write("HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: keep-alive\r\n\r\nproxy!");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as http from "node:http";
http.globalAgent.maxSockets = 1;
http.globalAgent.maxTotalSockets = 1;
http.setGlobalProxyFromEnv({ HTTP_PROXY: "http://127.0.0.1:${proxyPort}" });
http.request({ host: "127.0.0.1", port: ${originPort}, path: "/first" }, (res) => {
  res.resume();
  res.on("end", () => {
    http.setGlobalProxyFromEnv({});
    http.request({ host: "127.0.0.1", port: ${originPort}, path: "/second" }, (res2) => {
      let body = "";
      res2.setEncoding("utf8");
      res2.on("data", (chunk) => { body += chunk; });
      res2.on("end", () => console.log("second", res2.statusCode, body));
    }).on("error", (e) => console.log("second error", e.code)).end();
  });
}).on("error", (e) => console.log("first error", e.code)).end();
`;
  try {
    const { bin } = await build("switchoff", source);
    const native = await run(bin, []);
    expect(native).toContain("second 200 direct");
    expect(proxyHeads).toContain(`GET http://127.0.0.1:${originPort}/first HTTP/1.1`);
    expect(proxyHeads.some((line) => line.includes("/second"))).toBe(false);
    expect(originHeads).toContain("GET /second");
  } finally {
    for (const sock of cons) sock.destroy();
    origin.close();
    proxy.close();
  }
});
