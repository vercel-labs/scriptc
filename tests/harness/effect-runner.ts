import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { CompileResult } from "@scriptc/compiler";

const exec = promisify(execFile);
const source = new URL("../../packages/compiler/src/index.ts", import.meta.url).href;
const child = `import { compile } from ${JSON.stringify(source)};
  import { writeFileSync } from "node:fs";
  const result = await compile(process.argv[1], JSON.parse(process.argv[2]));
  writeFileSync(process.argv[3], JSON.stringify(result));`;

// One fixture's compile, and its whole test (the Node reference, the
// compile, the run). The sanitized lane gets twice the plain limits. Alone
// on a runner the slowest sanitized compile takes 170 to 262 s
// (cluster-handlers.ts, ten CI runs), but a Sandbox lane runs a fixture
// beside the other case files of its shard, and on a slow machine that
// doubles: in 57 rounds sanitized fixtures passed at up to 539 s and seven
// runs of three fixtures were killed at 540 s. Plain fixtures stayed under
// 450 s in the same rounds.
const laneFactor = process.env["SCRIPTC_SAN"] === "1" ? 2 : 1;
const compileLimit = 540_000 * laneFactor;
export const effectFixtureTimeout = 600_000 * laneFactor;

async function run(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(command, args, { encoding: "utf8", timeout: 60_000 });
    return { stdout, stderr, status: 0 };
  } catch (error) {
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof result.code !== "number") throw error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.code };
  }
}

export async function checkEffectFixture(
  entry: string,
  npmStatic: string[],
  optimization: "dev" | "release",
) {
  const sanitize = process.env["SCRIPTC_SAN"] === "1";
  const dir = await mkdtemp("/tmp/scriptc-effect-");
  try {
    const reference = await run(process.execPath, ["--no-warnings", entry]);
    expect(reference.status).toBe(0);
    expect(reference.stdout.trim().length).toBeGreaterThan(0);
    const options = {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "llvm",
      optimization,
      npmStatic,
      sanitize,
    };
    // Isolate checker state and process-wide compiler options between
    // concurrent fixtures. Published cluster graphs need extra heap.
    const resultPath = join(dir, "compile.json");
    await exec(
      process.execPath,
      [
        "--max-old-space-size=8192",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        child,
        entry,
        JSON.stringify(options),
        resultPath,
      ],
      { timeout: compileLimit },
    );
    const result = JSON.parse(await readFile(resultPath, "utf8")) as CompileResult;
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const actual = await run(result.binaryPath, []);
    if (sanitize)
      actual.stderr = actual.stderr
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("scriptc RC audit skipped:") &&
            !/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext/.test(line),
        )
        .join("\n");
    expect(actual).toEqual(reference);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
