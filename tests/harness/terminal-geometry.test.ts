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

const colors = join(import.meta.dirname, "../fixtures/terminal-color-depth");

/** One run of a command on terminals in exactly `env` (observe.py), with the
 * process id of a warning report taken out. */
async function onTerminals(
  env: readonly string[],
  command: readonly string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  const observed = await run("python3", [join(colors, "observe.py"), ...env, "--", ...command], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = JSON.parse(observed.stdout) as { status: number; stdout: string; stderr: string };
  return { ...result, stderr: result.stderr.replace(/\(node:\d+\)/g, "(node:PID)") };
}

test.skipIf(process.platform === "win32")(
  "getColorDepth and hasColors on terminal streams answer as Node does for every environment rule",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-color-depth-"));
    try {
      const entry = join(colors, "main.ts");
      const result = await compile(entry, {
        outDir: dir,
        outPath: join(dir, "llvm"),
        backend: "llvm",
        sanitize: process.env["SCRIPTC_SAN"] === "1",
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      // The default environment (process.env) of each run; the table inside
      // the program passes its environments as objects.
      const environments: string[][] = [
        ["TERM=xterm-256color"],
        ["TERM=dumb", "COLORTERM=truecolor"],
        ["FORCE_COLOR=3", "NO_COLOR=1"],
        ["CI=true", "GITHUB_ACTIONS=true"],
        ["TERM_PROGRAM=iTerm.app", "TERM_PROGRAM_VERSION=3.4.19"],
        ["TERM=KONSOLE"],
        [],
      ];
      for (const env of environments) {
        const oracle = await onTerminals(env, [
          process.execPath,
          "--experimental-strip-types",
          entry,
        ]);
        expect(oracle.status).toBe(0);
        expect(oracle.stdout.split("\n").length).toBeGreaterThan(2000);
        expect(oracle.stdout).toContain("default stdout: number ");
        const native = await onTerminals(env, [result.binaryPath]);
        expect(native).toEqual(oracle);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
