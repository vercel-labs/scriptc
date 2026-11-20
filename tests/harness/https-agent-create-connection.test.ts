/* An https agent's default dialer is tls.connect, while the createConnection
 * path builds a plain net socket. The call refuses for a secure agent rather
 * than handing back an unencrypted connection for traffic the program asked
 * to secure; a plain http agent keeps dialing. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-https-agent-connect-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  name: string,
  source: string,
  optimization: "release" | "dev" = "release",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, source);
  const result = await compile(entry, {
    outPath: join(dir, name),
    outDir: dir,
    sanitize,
    optimization,
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return { code: -1, stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const failure = e as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("an https agent's dialer refuses instead of returning a plaintext socket", async () => {
  const { code, stderr } = await run(
    "secure-agent",
    `import * as https from "node:https";
const agent = new https.Agent({ keepAlive: true });
const socket = agent.createConnection({ port: 1, host: "127.0.0.1" });
console.log("dialed", socket !== null);
`,
  );
  expect(code).toBe(1);
  expect(stderr).toContain(
    "https.Agent createConnection (a TLS dial from an options record) is not supported yet",
  );
  expect(stderr).toContain("SC2020");
});

test("an http agent's dialer probes its capability before it validates arguments", async () => {
  // The dialer asks the event-target unit whether it is linked before it looks
  // at its arguments. That probe reads a variable, so a build that left it
  // undefined would fault here (an undefined symbol's address is zero) instead
  // of reaching the argument check below.
  for (const optimization of ["release", "dev"] as const) {
    const { code, stderr } = await run(
      `probe-${optimization}`,
      `import * as http from "node:http";
const agent = new http.Agent({ keepAlive: true });
agent.createConnection(undefined);
console.log("survived");
`,
      optimization,
    );
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("ERR_MISSING_ARGS");
  }
});

test("an http agent's dialer still dials", async () => {
  const { code, stdout } = await run(
    "plain-agent",
    `import * as http from "node:http";
import * as net from "node:net";
const server = net.createServer((socket) => socket.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true });
  const socket = agent.createConnection({ port, host: "127.0.0.1" }, () => {
    console.log("connected");
    socket.end();
    server.close();
    agent.destroy();
  });
  socket.on("data", () => console.log("data"));
});
`,
  );
  expect(code).toBe(0);
  expect(stdout).toContain("connected");
  expect(stdout).toContain("data");
});
