/* A terminal interface whose output is process.stderr measures the columns of
 * the descriptor that output writes to. Node reads the output stream's own
 * columns, so a prompt that crosses the terminal row leaves the cursor on the
 * wrapped column; an interface that took the converted stream for an unbounded
 * one would ask for the unwrapped column instead. The fixture runs both worlds
 * on a pty 40 columns wide with a 52-column prompt. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/readline-stderr-columns");
const width = 40;
const prompt = "0123456789".repeat(5) + "> ";

test.skipIf(process.platform === "win32")(
  "a stderr terminal output wraps at the terminal's columns",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-readline-stderr-columns-"));
    try {
      const entry = join(fixture, "main.ts");
      const script = join(fixture, "observe.py");
      const oracle = await run("python3", [
        script,
        String(width),
        process.execPath,
        "--no-warnings",
        "--experimental-strip-types",
        entry,
      ]);
      const expected = JSON.parse(oracle.stdout) as { stderr: string; returncode: number };
      expect(expected.returncode).toBe(0);
      expect(expected.stderr).toBe(`\u001b[1G\u001b[0J${prompt}\u001b[13G`);
      // Apple ASan can make malloc abandon its nano zone and write a startup warning to the PTY.
      const nativeEnv =
        process.platform === "darwin" && process.env["SCRIPTC_SAN"] === "1"
          ? { ...process.env, MallocNanoZone: "0" }
          : process.env;
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "main"),
        backend: "llvm",
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const native = await run("python3", [script, String(width), result.binaryPath], {
        env: nativeEnv,
      });
      expect(JSON.parse(native.stdout)).toEqual(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
