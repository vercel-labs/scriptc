/* The module's environment proxy covers an https target through a CONNECT
 * tunnel: the request dials the proxy and asks it to reach the target, and
 * NO_PROXY exempts a target so it is dialed directly. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-https-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: import("node:net").Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function proxy(onHead: (head: string, sock: import("node:net").Socket) => void) {
  const server = createNetServer((sock) => {
    sock.once("data", (buf) => onHead(buf.toString("utf8"), sock));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function run(
  name: string,
  source: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return { code: -1, stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { timeout: 20000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const failure = e as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("an https request under the environment proxy asks the proxy to tunnel", async () => {
  const heads: string[] = [];
  const proxyPort = await proxy((head, sock) => {
    heads.push(head.split("\r\n")[0] ?? "");
    sock.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
  });
  const { stdout } = await run(
    "https-tunnel",
    `import * as http from "node:http";
import * as https from "node:https";
http.setGlobalProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:${proxyPort}" });
https.get("https://target.invalid/x").on("error", (e) => console.log("error", e.code));
`,
  );
  expect(stdout.trim()).toBe("error ERR_PROXY_TUNNEL");
  expect(heads).toEqual(["CONNECT target.invalid:443 HTTP/1.1"]);
});

test("NO_PROXY exempts an https target from the proxy", async () => {
  const heads: string[] = [];
  const proxyPort = await proxy((head) => {
    heads.push(head);
  });
  const { stdout } = await run(
    "https-no-proxy",
    `import * as http from "node:http";
import * as https from "node:https";
http.setGlobalProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:${proxyPort}", NO_PROXY: "target.invalid" });
https.get("https://target.invalid/x").on("error", (e) => console.log("error", e.code));
`,
  );
  // the request dials the target directly (the name does not resolve) and
  // never reaches the proxy
  expect(stdout.trim()).toBe("error ENOTFOUND");
  expect(heads).toEqual([]);
});
