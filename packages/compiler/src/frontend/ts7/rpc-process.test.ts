import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Ts7FifoIo } from "./rpc-process.js";

const execFileAsync = promisify(execFile);
const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test.skipIf(!posix)("a FIFO server echoes, and exits when its transport closes", () => {
  const io = new Ts7FifoIo("/bin/cat", []);
  const bytes = Buffer.from("ping\n");
  expect(io.write(bytes, 0, bytes.length)).toBe(bytes.length);
  const reply = Buffer.alloc(16);
  expect(reply.subarray(0, io.read(reply, 0, reply.length)).toString()).toBe("ping\n");
  io.close();
  io.close();
  expect(() => io.read(reply, 0, 1)).toThrow("closed");
  // The server is not this process's child: init reaps it once it exits.
  const deadline = Date.now() + 5000;
  while (alive(io.pid) && Date.now() < deadline) execFileSync("sleep", ["0.01"]);
  expect(alive(io.pid)).toBe(false);
});

test.skipIf(!posix)("a missing FIFO server fails at construction and tracks nothing", () => {
  const before = process.listenerCount("exit");
  expect(() => new Ts7FifoIo("/nonexistent/scriptc-ts7-server", [])).toThrow(
    "Unable to start TypeScript server",
  );
  expect(process.listenerCount("exit")).toBe(before);
});

test.skipIf(!posix)(
  "replaced and closed checker servers leave no zombie children behind",
  async () => {
    // Source budget 1: every parse after the first replaces the server.
    const parserUrl = new URL("./source-parser.ts", import.meta.url).href;
    const apiUrl = new URL("./rpc-api.ts", import.meta.url).href;
    const host = `
    import { execFileSync } from 'node:child_process';
    import { Ts7SourceParser } from ${JSON.stringify(parserUrl)};
    import { Ts7Api } from ${JSON.stringify(apiUrl)};
    const parser = new Ts7SourceParser((options) => new Ts7Api(options), process.cwd(), 1);
    for (let n = 0; n < 12; n++) parser.parse('f' + n + '.ts', 'export const v' + n + ' = ' + n + ';', 'ts');
    parser.close();
    const zombies = execFileSync('ps', ['-A', '-o', 'ppid=,stat='], { encoding: 'utf8' })
      .split('\\n')
      .map((line) => line.trim().split(/\\s+/))
      .filter(([ppid, stat]) => Number(ppid) === process.pid && (stat ?? '').startsWith('Z'));
    console.log(JSON.stringify({ zombies: zombies.length }));
  `;
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", host],
      { timeout: 60_000 },
    );
    expect(JSON.parse(result.stdout)).toEqual({ zombies: 0 });
    expect(result.stderr).toBe("");
  },
);

const reapModuleUrl = new URL("./rpc-process.ts", import.meta.url).href;

/** A server stand-in that ignores its input and sleeps: only the lifetime
 * watch can stop it. */
function fakeServer(): string {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-reap-"));
  const executable = join(directory, "server");
  writeFileSync(executable, "#!/bin/sh\nexec sleep 60\n");
  chmodSync(executable, 0o755);
  return executable;
}

async function waitForDeath(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 100; waited++) {
    if (!alive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

/** A scriptc-like process that starts a server and then exits in `mode`. */
function startHarness(
  executable: string,
  mode: "exit" | "throw" | "sleep",
): ReturnType<typeof spawn> {
  const code = `import { Ts7FifoIo } from ${JSON.stringify(reapModuleUrl)};
const io = new Ts7FifoIo(${JSON.stringify(executable)}, []);
console.log(io.pid);
if (${JSON.stringify(mode)} === "sleep") setInterval(() => {}, 1000);
if (${JSON.stringify(mode)} === "throw") throw new Error("boom");`;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function serverPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let text = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      text += chunk;
      const line = text.split("\n", 1)[0]!.trim();
      if (/^\d+$/.test(line)) resolve(Number(line));
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = text.split("\n", 1)[0]!.trim();
      if (/^\d+$/.test(line)) resolve(Number(line));
      else reject(new Error(`harness exited ${String(code)} before printing its server: ${text}`));
    });
  });
}

const cases: readonly (readonly [string, "exit" | "throw" | "sleep", NodeJS.Signals | null])[] = [
  ["a normal exit", "exit", null],
  ["an error exit", "throw", null],
  ["SIGTERM", "sleep", "SIGTERM"],
  ["SIGKILL", "sleep", "SIGKILL"],
];
for (const [label, mode, signal] of cases) {
  test.skipIf(!posix)(`${label} leaves no TypeScript server behind`, async () => {
    const child = startHarness(fakeServer(), mode);
    const pid = await serverPid(child);
    if (signal !== null) child.kill(signal);
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(await waitForDeath(pid)).toBe(true);
  });
}

test.skipIf(process.platform !== "linux")(
  "keeps the server's PID under a live supervisor while it runs",
  () => {
    const io = new Ts7FifoIo(fakeServer(), []);
    const pid = io.pid;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      // A detached server would be reparented to init, whose reap frees the
      // PID for reuse while the lifetime watcher still holds it.
      expect(ppid).not.toBe(1);
      expect(alive(ppid)).toBe(true);
    } finally {
      io.close();
    }
  },
);

test.skipIf(!posix)("closing after the server exited reaps it without a signal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-reap-short-"));
  const executable = join(directory, "server");
  writeFileSync(executable, "#!/bin/sh\nexit 3\n");
  chmodSync(executable, 0o755);
  const io = new Ts7FifoIo(executable, []);
  const pid = io.pid;
  expect(await waitForDeath(pid)).toBe(true);
  expect(() => io.close()).not.toThrow();
});
