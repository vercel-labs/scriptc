/* Proxy routing never outranks an explicit Unix socket, and a connection
 * made for the proxy never carries a later direct request. */
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

test("a socketPath request ignores the environment proxy", async () => {
  const sockPath = join(dir, "daemon.sock");
  const served: string[] = [];
  const unix = createNetServer((sock) => {
    sock.once("data", (buf) => {
      served.push(buf.toString("utf8").split("\r\n")[0] ?? "");
      sock.end("HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ndaemon");
    });
  });
  await new Promise<void>((resolve) => unix.listen(sockPath, resolve));
  const proxyHeads: string[] = [];
  const cons: import("node:net").Socket[] = [];
  const proxy = createNetServer((sock) => {
    cons.push(sock);
    sock.once("data", (buf) => {
      proxyHeads.push(buf.toString("utf8").split("\r\n")[0] ?? "");
      sock.end("HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\nproxyd");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as http from "node:http";
http.setGlobalProxyFromEnv({ HTTP_PROXY: "http://127.0.0.1:${proxyPort}" });
const req = http.request({ socketPath: ${JSON.stringify(sockPath)}, path: "/status", method: "GET" }, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("body", body));
});
req.on("error", (e) => console.log("error", e.code));
req.end();
`;
  try {
    const { bin } = await build("unix", source);
    const native = await run(bin, []);
    expect(native.trim()).toBe("body daemon");
    expect(served).toEqual(["GET /status HTTP/1.1"]);
    expect(proxyHeads).toEqual([]);
  } finally {
    for (const sock of cons) sock.destroy();
    unix.close();
    proxy.close();
  }
});
