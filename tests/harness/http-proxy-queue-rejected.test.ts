/* The agent queue's proxy interactions: a rejected proxied target leaves no
 * socket behind, and a queued proxied request never takes a pooled direct
 * connection (which would send its proxy credentials to the origin). */
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

test("a rejected proxied target leaves no socket when the agent is at its cap", async () => {
  const heads: string[] = [];
  const cons: import("node:net").Socket[] = [];
  const proxy = createNetServer((sock) => {
    cons.push(sock);
    sock.once("data", (buf) => {
      heads.push(buf.toString("utf8").split("\r\n")[0] ?? "");
      // the first request holds the only slot long enough to queue the rest
      setTimeout(() => {
        sock.end("HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nslow");
      }, 200);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const source = `import * as http from "node:http";
http.globalAgent.maxSockets = 1;
http.globalAgent.maxTotalSockets = 1;
http.setGlobalProxyFromEnv({ HTTP_PROXY: "http://127.0.0.1:${proxyPort}" });
const before = process.getActiveResourcesInfo().length;
let thrown = 0;
const slow = http.request({ host: "target.invalid", port: 80, path: "/slow" }, (res) => {
  res.resume();
  res.on("end", () => {
    const after = process.getActiveResourcesInfo().length;
    console.log("thrown", thrown, "delta", after - before);
  });
});
slow.on("socket", () => {
  for (let i = 0; i < 20; i++) {
    try {
      http.request({ host: "target.invalid", port: 80, path: "x" }).on("error", () => {});
    } catch {
      thrown += 1;
    }
  }
});
slow.end();
`;
  try {
    const bin = await build("rejected", source);
    const stdout = await run(bin, {});
    const [thrown, delta] = /thrown (\d+) delta (-?\d+)/.exec(stdout)?.slice(1).map(Number) ?? [];
    expect(thrown).toBe(20);
    // the only live resource left is the slow request's own socket
    expect(delta).toBeLessThanOrEqual(1);
    expect(heads[0]).toBe("GET http://target.invalid/slow HTTP/1.1");
  } finally {
    for (const sock of cons) sock.destroy();
    proxy.close();
  }
});
