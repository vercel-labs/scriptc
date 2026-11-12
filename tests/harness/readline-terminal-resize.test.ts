import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/readline-terminal-resize");

test.skipIf(process.platform === "win32")(
  "a terminal readline interface redraws on a resized PTY as Node does",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-readline-resize-"));
    try {
      const entry = join(fixture, "main.ts");
      const script = join(fixture, "observe.py");
      const oracle = await run("python3", [
        script,
        process.execPath,
        "--experimental-strip-types",
        entry,
      ]);
      expect(oracle.stderr).toBe("");
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "llvm"),
        backend: "llvm",
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      // Apple ASan can make malloc abandon its nano zone and write a startup warning to the PTY.
      const nativeEnv =
        process.platform === "darwin" && process.env["SCRIPTC_SAN"] === "1"
          ? { ...process.env, MallocNanoZone: "0" }
          : process.env;
      const native = await run("python3", [script, result.binaryPath], { env: nativeEnv });
      expect(native.stderr).toBe("");
      expect(native.stdout).toBe(oracle.stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
