/* chalk 5 compiled from its published JavaScript (tests/fixtures/npm/cases/
 * chalk5): the program runs under Node and as a native binary with each
 * color-detection input supports-color reads — FORCE_COLOR values and the
 * --color/--no-color flags — and stdout, stderr and the exit status must
 * match byte for byte. npm.test.ts runs the same case once in the
 * harness's own environment. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/chalk5/main.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/chalk5");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    const pending = execFileAsync(cmd, args, { cwd: dirname(entry), env, encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.stdout !== "string" || typeof e.stderr !== "string") throw err;
    return {
      stdout: e.stdout,
      stderr: e.stderr,
      exitCode: typeof e.code === "number" ? e.code : -1,
    };
  }
}

/** The harness environment without the color inputs, plus `force`. */
function colorEnv(force: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["FORCE_COLOR"];
  delete env["NO_COLOR"];
  delete env["NODE_DISABLE_COLORS"];
  if (force !== undefined) env["FORCE_COLOR"] = force;
  return env;
}

const cases: { name: string; force: string | undefined; argv: string[] }[] = [
  { name: "FORCE_COLOR unset", force: undefined, argv: [] },
  ...["0", "1", "2", "3", "true", "false", ""].map((force) => ({
    name: `FORCE_COLOR=${JSON.stringify(force)}`,
    force,
    argv: [],
  })),
  ...[
    ["--no-color"],
    ["--color"],
    ["--color=256"],
    ["--color=16m"],
    ["--color", "--", "--no-color"],
  ].map((argv) => ({ name: argv.join(" "), force: undefined, argv })),
  { name: "FORCE_COLOR=3 --no-color", force: "3", argv: ["--no-color"] },
];

let binary = "";

beforeAll(async () => {
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, { outPath: join(outDir, "program"), outDir, sanitize });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  binary = result.binaryPath;
}, 300_000);

describe("chalk 5 color detection matches Node", () => {
  for (const c of cases) {
    test(
      c.name,
      async () => {
        const env = colorEnv(c.force);
        const [node, native] = await Promise.all([
          run(process.execPath, [entry, ...c.argv], env),
          run(binary, c.argv, env),
        ]);
        expect(native.stdout).toBe(node.stdout);
        expect(native.stderr).toBe(node.stderr);
        expect(native.exitCode).toBe(node.exitCode);
      },
      60_000,
    );
  }
});
