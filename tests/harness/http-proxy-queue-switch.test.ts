/* The agent queue's proxy interactions: a rejected proxied target leaves no
 * socket behind, and a queued proxied request never takes a pooled direct
 * connection (which would send its proxy credentials to the origin). */
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
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-queue-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function build(name: string, source: string): Promise<string> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) throw new Error("compile failed");
  return result.binaryPath;
}

async function run(bin: string, env: Record<string, string>): Promise<string> {
  const base = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  try {
    const { stdout } = await execFileAsync(bin, [], { env: { ...base, ...env }, timeout: 20000 });
    return stdout;
  } catch (e) {
    const f = e as { stdout?: string; stderr?: string };
    throw new Error(
      "program failed: out=" + JSON.stringify(f.stdout) + " err=" + JSON.stringify(f.stderr),
    );
  }
}

test("a queued proxied request never takes a pooled direct connection", async () => {
  const originHeads: string[] = [];
  const originAuth: string[] = [];
  const origin = createHttpServer((req, res) => {
    originHeads.push(`${req.method} ${req.url}`);
    originAuth.push(String(req.headers["proxy-authorization"] ?? ""));
    if (req.url === "/first") {
      // a keep-alive response: the socket goes back to the agent's pool
      setTimeout(() => res.end("one"), 150);
      return;
    }
    res.end("direct");
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as { port: number }).port;
  const proxyHeads: string[] = [];
  const proxy = createNetServer((sock) => {
    sock.once("data", (buf) => {
      proxyHeads.push(buf.toString("utf8").split("\r\n")[0] ?? "");
      sock.end("HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nprx");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as http from "node:http";
http.globalAgent.maxSockets = 1;
http.globalAgent.maxTotalSockets = 1;
const first = http.request({ host: "127.0.0.1", port: ${originPort}, path: "/first" }, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("first", body));
});
first.on("socket", () => {
  // the proxy is switched on while the direct request still owns the slot
  http.setGlobalProxyFromEnv({ HTTP_PROXY: "http://user:secret@127.0.0.1:${proxyPort}" });
  http.request({ host: "127.0.0.1", port: ${originPort}, path: "/second" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => console.log("second", res.statusCode, body));
  }).on("error", (e) => console.log("error", e.code)).end();
});
first.end();
`;
  try {
    const bin = await build("switch", source);
    const stdout = await run(bin, {});
    expect(stdout).toContain("first one");
    expect(stdout).toContain("second 200 prx");
    // the origin never sees the proxy's credentials or the second request
    expect(originAuth.every((value) => value === "")).toBe(true);
    expect(originHeads).toEqual(["GET /first"]);
    expect(proxyHeads[0]).toBe(`GET http://127.0.0.1:${originPort}/second HTTP/1.1`);
  } finally {
    origin.close();
    proxy.close();
  }
});
