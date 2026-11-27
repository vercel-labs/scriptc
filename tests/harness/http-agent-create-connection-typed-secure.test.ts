/* The typed createConnection rewrite lowers an http.Agent receiver to the
 * net dialer, which builds a plaintext socket. An https.Agent can flow there
 * typed as http.Agent, so the runtime refuses a secure agent instead of
 * dialing it in the clear. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-connect-typed-secure-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  name: string,
  source: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(dir, `${name}.ts`);
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

test("a secure agent typed as http.Agent refuses the typed dialer", async () => {
  const { code, stderr, stdout } = await run(
    "secure-typed",
    `import * as http from "node:http";
import * as https from "node:https";
const secure: http.Agent = new https.Agent({ keepAlive: true });
const socket = secure.createConnection({ port: 1, host: "127.0.0.1" });
console.log("dialed", socket !== null);
`,
  );
  expect(code).toBe(1);
  expect(stderr).toContain(
    "https.Agent createConnection (a TLS dial from an options record) is not supported yet",
  );
  expect(stderr).toContain("SC2020");
  expect(stdout).not.toContain("dialed");
});

test("a foreign value typed as http.Agent refuses the typed dialer", async () => {
  // A Node-island https.Agent reaches the rewrite with a handle the runtime
  // cannot classify; dialing it plaintext would downgrade the TLS connection
  // the island agent would have made. The same fail-closed branch serves any
  // non-agent value that gets here through a cast.
  const { code, stderr, stdout } = await run(
    "foreign-typed",
    `import * as http from "node:http";
import * as net from "node:net";
const foreign = new net.Socket() as unknown as http.Agent;
const socket = foreign.createConnection({ port: 1, host: "127.0.0.1" });
console.log("dialed", socket !== null);
`,
  );
  expect(code).toBe(1);
  expect(stderr).toContain(
    "createConnection on an Agent this compiled program did not create is not supported yet",
  );
  expect(stderr).toContain("SC2020");
  expect(stdout).not.toContain("dialed");
});

test("an http agent typed as http.Agent still dials", async () => {
  const { code, stdout } = await run(
    "plain-typed",
    `import * as http from "node:http";
import * as net from "node:net";
const server = net.createServer((socket) => socket.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent: http.Agent = new http.Agent({ keepAlive: true });
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
