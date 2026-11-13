import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/readline-terminal-suspend");

/** Suspending a terminal interface: a registered 'SIGTSTP' listener takes
 * Ctrl+Z and the interface keeps going; without one the process stops on
 * Ctrl+Z (or on a SIGTSTP from outside), and SIGCONT pauses the interface,
 * emits 'SIGCONT' and redraws the line — an external stop and resume emits
 * no 'SIGCONT'. The observer pins the stop signal, the marker order and the
 * refresh, and compares every byte of the terminal output with Node's. The
 * "blocked" mode runs the same Ctrl+Z flow with SIGTSTP blocked in the
 * observer, so the program inherits a blocked stop, the way a program
 * started by a service manager or a CI runner can. */
for (const mode of ["listener", "default", "blocked", "external"] as const) {
  test.skipIf(process.platform === "win32")(
    `a terminal readline interface suspends and resumes the way Node does (${mode})`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scriptc-readline-suspend-"));
      try {
        const entry = join(fixture, "main.ts");
        const script = join(fixture, "observe.py");
        const oracle = await run("python3", [
          script,
          mode,
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
        const native = await run("python3", [script, mode, result.binaryPath], {
          env: nativeEnv,
        });
        expect(native.stderr).toBe("");
        expect(native.stdout).toBe(oracle.stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
}
