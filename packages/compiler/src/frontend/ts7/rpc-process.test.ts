import { execFile, execFileSync } from "node:child_process";
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
