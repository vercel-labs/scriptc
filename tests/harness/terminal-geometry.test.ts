import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/terminal-geometry");

test.skipIf(process.platform === "win32")(
  "stdio geometry matches Node on independent resized PTYs",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-geometry-"));
    try {
      const entry = join(fixture, "main.ts");
      const script = join(fixture, "observe.py");
      const oracle = await run("python3", [
        script,
        process.execPath,
        "--experimental-strip-types",
        entry,
      ]);
      expect(JSON.parse(oracle.stdout)).toEqual([
        [88, 48, 72, 30],
        [100, 52, 80, 24],
      ]);
      expect(oracle.stderr).toBe("");
      // Apple ASan can make malloc abandon its nano zone and write a startup warning to the PTY.
      const nativeEnv =
        process.platform === "darwin" && process.env["SCRIPTC_SAN"] === "1"
          ? { ...process.env, MallocNanoZone: "0" }
          : process.env;
      for (const backend of ["llvm"] as const) {
        const result = await compile(entry, {
          outDir: dir,
          outPath: join(dir, backend),
          backend,
          sanitize: process.env["SCRIPTC_SAN"] === "1",
        });
        if (!result.ok)
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const native = await run("python3", [script, result.binaryPath], { env: nativeEnv });
        expect(native.stdout).toBe(oracle.stdout);
        expect(native.stderr).toBe("");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

const listeners = join(import.meta.dirname, "../fixtures/terminal-resize-listeners");

test.skipIf(process.platform === "win32")(
  "resize listeners on terminal stream values fire as in Node on resized PTYs",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-resize-listeners-"));
    try {
      const entry = join(listeners, "main.ts");
      const script = join(listeners, "observe.py");
      const oracle = await run("python3", [
        script,
        process.execPath,
        "--experimental-strip-types",
        entry,
      ]);
      expect(JSON.parse(oracle.stdout)).toEqual([
        ["ready", true, true],
        ["out:once:101x41", "out:on:101x41", "err:once:81x21", "err:on:81x21"],
        [
          "out:once:101x41",
          "out:on:101x41",
          "err:once:81x21",
          "err:on:81x21",
          "out:on:102x42",
          "err:on:82x22",
        ],
        ["flushed", true],
      ]);
      expect(oracle.stderr).toBe("");
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
      expect(native.stdout).toBe(oracle.stdout);
      expect(native.stderr).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
