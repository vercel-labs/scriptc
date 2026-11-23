/* Writable.toWeb over a duck-typed writable whose strategy the stream
 * refuses: the failed construction must not root its adapter context. A
 * rooted context per refused call grows the process's peak RSS linearly with
 * the call count, so the check runs one program with a small and a large
 * count and bounds the difference. The program reads its own
 * /proc/self/status, so the test runs on Linux; ASan's quarantine is turned
 * off for the runs so freed memory is not counted as retention. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const PROGRAM = `import { Writable } from "node:stream";
import { readFileSync } from "node:fs";

function fake(hwm) {
  return {
    writable: true,
    destroyed: false,
    writableHighWaterMark: hwm,
    write() { return true; },
    end() {},
    destroy() {},
    on() {},
    removeListener() {},
  };
}

const count = Number(process.argv[2] ?? 0) || 10000;
let thrown = 0;
for (let i = 0; i < count; i++) {
  try {
    Writable.toWeb(fake(-1));
  } catch {
    thrown++;
  }
}
const status = readFileSync("/proc/self/status", "utf8");
const peak = /VmHWM:\\s+(\\d+) kB/.exec(status);
console.log("thrown", thrown, "peakKB", peak ? peak[1] : "?");
`;

test.skipIf(process.platform !== "linux")(
  "a refused duck-typed Writable.toWeb retains nothing",
  async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scriptc-writable-to-web-leak-"));
    const entry = join(outDir, "main.mjs");
    writeFileSync(entry, PROGRAM);
    const result = await compile(entry, {
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const peak = async (count: number): Promise<{ thrown: number; peakKB: number }> => {
      const { stdout } = await execFileAsync(result.binaryPath, [String(count)], {
        encoding: "utf8",
        env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1:quarantine_size_mb=0" },
      });
      const match = /^thrown (\d+) peakKB (\d+)$/m.exec(stdout);
      expect(match, stdout).not.toBeNull();
      return { thrown: Number(match![1]), peakKB: Number(match![2]) };
    };
    const small = await peak(10_000);
    const large = await peak(200_000);
    expect(small.thrown).toBe(10_000);
    expect(large.thrown).toBe(200_000);
    // A rooted context per refused call grows by hundreds of MB across this
    // range; the fixed adapter stays flat.
    expect(large.peakKB - small.peakKB).toBeLessThan(16 * 1024);
  },
  300_000,
);
