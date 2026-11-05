/* Process integration of in-process Node islands on the hosted loop
 * (scope-B milestone NI-3) where the corpus cannot compare byte for byte:
 * an uncaught exception or an unhandled rejection on either side once Node
 * is loaded. Each side prints its own report format (scriptc's for native
 * code, Node's for island code), and Node's report quotes source lines and
 * stack frames the two runs do not share, so stderr is checked for the
 * error, while stdout ('exit' listeners of both sides, with the code) and
 * the exit status must match Node exactly. The deterministic cases (signals,
 * exit codes, process.exit from either side, stdio) are corpus programs
 * 6804-6811. Needs a libnode pack in SCRIPTC_LIBNODE. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtures = join(repoRoot, "tests/fixtures/node-island-process");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-process");
const pack = process.env["SCRIPTC_LIBNODE"];
const skip = (process.platform !== "linux" && process.platform !== "darwin") || !pack;
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function run(cmd: string, args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
  }
}

async function both(name: string): Promise<{ node: Run; native: Run }> {
  const main = join(fixtures, `${name}.ts`);
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const built = await compile(main, { outPath: join(dir, "program"), outDir: dir, sanitize });
  if (!built.ok)
    throw new Error(built.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const [node, native] = await Promise.all([run("node", [main]), run(built.binaryPath, [])]);
  return { node, native };
}

describe.skipIf(skip)("Node island process integration", () => {
  test.for([
    ["native-uncaught", "Error: native boom"],
    ["island-uncaught", "Error: island boom"],
    ["native-rejection", "native rejected"],
    ["island-rejection", "island rejected"],
  ] as const)("%s", { timeout: 300_000 }, async ([name, error]) => {
    const { node, native } = await both(name);
    expect(node.code).toBe(1);
    expect(native.code).toBe(node.code);
    expect(native.stdout).toBe(node.stdout);
    expect(node.stderr).toContain(error);
    expect(native.stderr).toContain(error);
  });
});
