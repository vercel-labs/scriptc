/* SPEC §5.4's duplicate guard, where the two runs diverge on purpose, so a
 * harness test rather than a corpus program: a run-time require that
 * resolves to a module the program compiled throws
 * ERR_SCRIPTC_DUPLICATE_MODULE, where Node.js hands back its one instance.
 * The rest of the runtime-filesystem require (loading a file written at run
 * time, MODULE_NOT_FOUND, argument order) is corpus program 2880, which
 * matches Node byte for byte. Needs a libnode pack (SCRIPTC_LIBNODE). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtures = join(repoRoot, "tests/fixtures/node-island-runtime-require");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-runtime-require");
// Required in the Linux x64 CI lanes, where a missing pack fails here.
const pack = libnodePack();
const skip = pack === null;
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Linux ASan's once-per-process warning at the first context switch (the
 * runtime's fibers and Node's stack): not program output. */
const ASAN_SWAP = /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm;

async function run(cmd: string, args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { stdout, stderr: stderr.replace(ASAN_SWAP, ""), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.code !== "number") throw err;
    return {
      stdout: e.stdout ?? "",
      stderr: (e.stderr ?? "").replace(ASAN_SWAP, ""),
      code: e.code,
    };
  }
}

describe.skipIf(skip)("Node island runtime-filesystem require", () => {
  test(
    "a computed require of the program's own module is refused",
    { timeout: 300_000 },
    async () => {
      const main = join(fixtures, "main.ts");
      const dir = join(outDir, "duplicate");
      mkdirSync(dir, { recursive: true });
      const built = await compile(main, { outPath: join(dir, "program"), outDir: dir, sanitize });
      if (!built.ok)
        throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));

      const [node, native] = await Promise.all([run("node", [main]), run(built.binaryPath, [])]);
      // Node.js: the require sees the one instance the program registered into.
      expect(node.code).toBe(0);
      expect(node.stdout).toContain("loaded 1");
      expect(node.stdout).toContain("size 1");
      // The compiled program: a loud refusal, and still one instance.
      expect(native.code).toBe(node.code);
      expect(native.stdout).toContain("refused ERR_SCRIPTC_DUPLICATE_MODULE");
      expect(native.stdout).toContain("detail true");
      expect(native.stdout).toContain("size 1");
      // The program itself writes nothing to stderr (Node may warn about
      // the fixture's TypeScript source where it strips types).
      expect(native.stderr).toBe("");
      // A non-string specifier is Node.js's own error on both sides.
      const value =
        'value ERR_INVALID_ARG_TYPE The "id" argument must be of type string. Received type number (5)';
      expect(node.stdout).toContain(value);
      expect(native.stdout).toContain(value);
    },
  );
});
