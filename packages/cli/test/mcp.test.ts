import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const work = mkdtempSync(join(tmpdir(), "scriptc-mcp-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const programs: Record<string, string> = {
  "hello.ts": 'console.log("hello", 6 * 7);\n',
  "type-error.ts": 'const n: number = "not a number";\nconsole.log(n);\n',
  "stdin.ts":
    'let bytes = 0;\nprocess.stdin.on("data", (chunk) => {\n  bytes += chunk.length;\n});\nprocess.stdin.on("end", () => console.log("stdin ended after", bytes, "bytes"));\n',
  "forever.ts":
    'import { writeFileSync } from "node:fs";\nwriteFileSync("pid.txt", String(process.pid));\nsetInterval(() => {}, 1000);\n',
  "daemon.ts":
    'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn("sleep", ["30"], { detached: true, stdio: "inherit" });\nwriteFileSync("daemon.pid", String(child.pid));\nconsole.log("started");\nprocess.exit(0);\n',
  "loud.ts":
    'const line = "x".repeat(1023) + "\\n";\nlet out = "";\nfor (let i = 0; i < 9 * 1024; i++) out += line;\nprocess.stdout.write(out);\n',
};
for (const [name, source] of Object.entries(programs)) writeFileSync(join(work, name), source);

/** A connected `scriptc mcp` server and the messages it has written. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: JsonObject[] = [];
  private nextId = 1;
  private buffer = "";
  readonly exited: Promise<number | null>;

  constructor() {
    this.child = spawn(process.execPath, ["--import", tsxLoader, cliEntry, "mcp"], {
      cwd: work,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        this.messages.push(JSON.parse(this.buffer.slice(0, newline)) as JsonObject);
        this.buffer = this.buffer.slice(newline + 1);
      }
    });
    this.exited = new Promise((resolveExit) => this.child.on("exit", (code) => resolveExit(code)));
  }

  send(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params?: JsonObject): number {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return id;
  }

  call(name: string, args: JsonObject): number {
    return this.request("tools/call", { name, arguments: args });
  }

  async response(id: number, timeoutMs = 120_000): Promise<JsonObject> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((message) => message["id"] === id);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no response to ${id}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  async result(id: number): Promise<JsonObject> {
    const message = await this.response(id);
    if (message["result"] === undefined) throw new Error(JSON.stringify(message));
    return message["result"] as JsonObject;
  }
}

const clients: Client[] = [];
function connect(): Client {
  const client = new Client();
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.child.kill("SIGKILL");
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

test("a client lists the tools, then runs, checks and builds a program", async () => {
  const client = connect();
  const init = await client.result(
    client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    }),
  );
  expect(init).toMatchObject({ protocolVersion: "2025-11-25", serverInfo: { name: "scriptc" } });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = (await client.result(client.request("tools/list")))["tools"] as JsonObject[];
  expect(tools.map((tool) => tool["name"])).toContain("scriptc_run");

  const run = await client.result(client.call("scriptc_run", { file: "hello.ts" }));
  expect(run).toMatchObject({
    isError: false,
    structuredContent: { exitCode: 0, stdout: "hello 42\n" },
  });

  const coverage = await client.result(client.call("scriptc_coverage", { file: "hello.ts" }));
  expect(coverage).toMatchObject({
    isError: false,
    structuredContent: {
      exitCode: 0,
      diagnostics: { schema: "scriptc-diagnostics", command: "coverage", success: true },
    },
  });

  const out = join(work, "hello-bin");
  const build = await client.result(client.call("scriptc_build", { file: "hello.ts", out }));
  expect(build).toMatchObject({
    isError: false,
    structuredContent: { exitCode: 0, diagnostics: { success: true, artifact: out } },
  });
  expect(existsSync(out)).toBe(true);
});

test("a program that does not compile returns its diagnostics as a tool error", async () => {
  const client = connect();
  const result = await client.result(client.call("scriptc_build", { file: "type-error.ts" }));
  expect(result["isError"]).toBe(true);
  const diagnostics = (result["structuredContent"] as JsonObject)["diagnostics"] as JsonObject;
  expect(diagnostics["success"]).toBe(false);
  expect(JSON.stringify(diagnostics["diagnostics"])).toContain('"file"');
});

test("the program's stdin is closed, never the server's", async () => {
  const client = connect();
  const result = await client.result(client.call("scriptc_run", { file: "stdin.ts" }));
  expect(result["structuredContent"]).toMatchObject({
    exitCode: 0,
    stdout: "stdin ended after 0 bytes\n",
  });
  expect(await client.result(client.request("ping"))).toMatchObject({ resultType: "complete" });
});

test("flag-shaped arguments reach the command as values", async () => {
  const client = connect();
  const result = await client.result(client.call("scriptc_build", { file: "--help" }));
  expect(result["isError"]).toBe(true);
  const text = JSON.stringify(result);
  expect(text).not.toContain("Usage:");
  expect(text).toContain("--help");
});

test("cancelling a run stops the program and everything it started", async () => {
  const client = connect();
  const id = client.call("scriptc_run", { file: "forever.ts" });
  await waitFor(() => existsSync(join(work, "pid.txt")));
  const pid = Number(readFileSync(join(work, "pid.txt"), "utf8"));
  rmSync(join(work, "pid.txt"));
  expect(alive(pid)).toBe(true);
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
  await waitFor(() => !alive(pid), 10_000);
  expect(await client.result(client.request("ping"))).toMatchObject({ resultType: "complete" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  expect(client.messages.some((message) => message["id"] === id)).toBe(false);
});

test("calls past the concurrency limit are refused, and closing stdin stops nothing early", async () => {
  const client = connect();
  const ids = [1, 2, 3, 4].map(() => client.call("scriptc_run", { file: "hello.ts" }));
  const extra = client.call("scriptc_run", { file: "hello.ts" });
  const refused = await client.result(extra);
  expect(refused).toMatchObject({ isError: true });
  expect(JSON.stringify(refused)).toContain("already running");
  client.child.stdin.end();
  expect(await client.exited).toBe(0);
  for (const id of ids) {
    expect(await client.result(id)).toMatchObject({ structuredContent: { stdout: "hello 42\n" } });
  }
});

test("SIGTERM stops running programs before the server exits", async () => {
  const client = connect();
  client.call("scriptc_run", { file: "forever.ts" });
  await waitFor(() => existsSync(join(work, "pid.txt")));
  const pid = Number(readFileSync(join(work, "pid.txt"), "utf8"));
  rmSync(join(work, "pid.txt"));
  client.child.kill("SIGTERM");
  expect(await client.exited).toBe(143);
  await waitFor(() => !alive(pid), 10_000);
});

test("a call ends when its command exits, even if a process it left holds the output open", async () => {
  const client = connect();
  const started = Date.now();
  const result = await client.result(client.call("scriptc_run", { file: "daemon.ts" }));
  const daemon = Number(readFileSync(join(work, "daemon.pid"), "utf8"));
  try {
    expect(result["structuredContent"]).toMatchObject({ exitCode: 0, stdout: "started\n" });
    expect(Date.now() - started).toBeLessThan(25_000);
    client.child.stdin.end();
    expect(await client.exited).toBe(0);
    expect(alive(daemon)).toBe(true);
  } finally {
    process.kill(daemon, "SIGKILL");
  }
});

test("output past the limit is cut and marked truncated", async () => {
  const client = connect();
  const result = await client.result(client.call("scriptc_run", { file: "loud.ts" }));
  const structured = result["structuredContent"] as JsonObject;
  expect(structured["exitCode"]).toBe(0);
  expect(structured["truncated"]).toBe(true);
  expect((structured["stdout"] as string).length).toBe(8 * 1024 * 1024);
});

test("a duplicate request id, a NUL byte and deeply nested JSON are refused without harm", async () => {
  const client = connect();
  client.send({
    jsonrpc: "2.0",
    id: "same",
    method: "tools/call",
    params: { name: "scriptc_run", arguments: { file: "hello.ts" } },
  });
  client.send({
    jsonrpc: "2.0",
    id: "same",
    method: "tools/call",
    params: { name: "scriptc_run", arguments: { file: "hello.ts" } },
  });
  const nul = await client.result(client.call("scriptc_run", { file: "hello\u0000.ts" }));
  expect(nul["isError"]).toBe(true);
  client.child.stdin.write(`${"[".repeat(1_000_000)}\n`);
  const ping = await client.result(client.request("ping"));
  expect(ping).toMatchObject({ resultType: "complete" });
  await waitFor(() => client.messages.filter((message) => message["id"] === "same").length === 2);
  const same = client.messages.filter((message) => message["id"] === "same");
  expect(same.map((message) => (message["error"] as JsonObject | undefined)?.["code"])).toEqual([
    -32600,
    undefined,
  ]);
  expect(
    client.messages.some(
      (message) => (message["error"] as JsonObject | undefined)?.["code"] === -32700,
    ),
  ).toBe(true);
});

test("an oversized or malformed message is refused and the server keeps serving", async () => {
  const client = connect();
  client.child.stdin.write(
    `{"jsonrpc":"2.0","id":"big","method":"ping","params":{"x":"${"x".repeat(5 * 1024 * 1024)}"}}\n`,
  );
  client.child.stdin.write("not json\n");
  const id = client.request("ping");
  expect(await client.result(id)).toMatchObject({ resultType: "complete" });
  const errors = client.messages.filter((message) => message["id"] === null);
  expect(errors.map((message) => (message["error"] as JsonObject)["code"])).toEqual([
    -32600, -32700,
  ]);
  expect(client.messages.some((message) => message["id"] === "big")).toBe(false);
});
