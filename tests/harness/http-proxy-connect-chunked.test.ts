/* A chunked request that ends while its CONNECT tunnel is still being set up
 * must still send the terminating chunk and its trailers once the tunnel is
 * up: the target's request body has to finish, or it never answers. */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-http-proxy-connect-chunked-"));
const certs = join(import.meta.dirname, "../fixtures/server/certs");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a chunked request that ends before CONNECT completes still finishes its body", async () => {
  const server = createHttpsServer(
    {
      key: readFileSync(join(certs, "localhost-key.pem")),
      cert: readFileSync(join(certs, "localhost.pem")),
    },
    (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        console.log("body", body, "trailer", String(req.trailers["x-checksum"]));
        res.end("ok");
      });
    },
  );
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
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;

  const entry = join(dir, "chunked.mjs");
  writeFileSync(
    entry,
    `import * as http from "node:http";
import * as https from "node:https";
http.setGlobalProxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:${proxyPort}" });
const req = https.request({
  host: "127.0.0.1",
  port: ${targetPort},
  path: "/post",
  method: "POST",
  rejectUnauthorized: false,
}, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => console.log("response", body));
});
req.on("error", (e) => console.log("error", e.code));
req.setTimeout(4000, () => { console.log("timeout"); req.destroy(); });
req.write("abc");
req.addTrailers({ "x-checksum": "sum" });
req.end("def");
`,
  );

  try {
    const result = await compile(entry, { outPath: join(dir, "chunked"), outDir: dir, sanitize });
    expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
    if (!result.ok) return;
    try {
      const { stdout } = await execFileAsync(result.binaryPath, [], { timeout: 20000 });
      expect(stdout.trim()).toBe("response ok");
    } catch (e) {
      const f = e as { stdout?: string; stderr?: string; signal?: string };
      throw new Error(
        "program failed: out=" +
          JSON.stringify(f.stdout) +
          " err=" +
          JSON.stringify(f.stderr) +
          " sig=" +
          String(f.signal),
      );
    }
  } finally {
    for (const sock of cons) sock.destroy();
    proxy.close();
    server.close();
  }
});
