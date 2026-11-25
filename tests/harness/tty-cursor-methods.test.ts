/* tty.WriteStream's cursor methods on a real PTY: the exact escape bytes
 * Node writes for cursorTo/moveCursor/clearLine/clearScreenDown, the
 * completion callback, and the zero-delta moveCursor no-op. Node is the
 * oracle; the compiled binary must write the same bytes. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/tty-cursor");

test.skipIf(process.platform === "win32")(
  "cursor methods write Node's escape sequences on a PTY",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-tty-cursor-"));
    try {
      const entry = join(fixture, "main.ts");
      const script = join(fixture, "observe.py");
      const oracle = await run("python3", [
        script,
        process.execPath,
        "--experimental-strip-types",
        entry,
      ]);
      const parsed = JSON.parse(oracle.stdout) as { out: string; code: number; err: string };
      expect(parsed.code).toBe(0);
      expect(parsed.err).toBe("");
      const nativeEnv =
        process.platform === "darwin" && process.env["SCRIPTC_SAN"] === "1"
          ? { ...process.env, MallocNanoZone: "0" }
          : process.env;
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "llvm"),
        backend: "llvm",
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const native = await run("python3", [script, result.binaryPath], { env: nativeEnv });
      const got = JSON.parse(native.stdout) as { out: string; code: number; err: string };
      expect(got.out).toBe(parsed.out);
      expect(native.stdout).toBe(oracle.stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
