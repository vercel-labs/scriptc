/* The stderr report of a deferred refusal that fires. A JavaScript statement
 * that does not compile becomes a throw of its diagnostic at the operation
 * that reaches it (a runtime fence). The Error is catchable, so a handler
 * above it, the program's or a framework's, could turn a compiler gap into a
 * wrong answer with nothing on stderr. The first time each site fires, the
 * runtime names it on stderr (scr_deferred_fence.c); SCRIPTC_DEFERRED_REPORT=0
 * silences that, and a program without such a site does not link the unit.
 *
 * These cannot be corpus programs: corpus output matches Node byte for byte,
 * and under Node the fenced operation works. */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(import.meta.dirname, "../../node_modules/.cache/scriptc-tests/deferred-fence");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function build(name: string, file: string, source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-deferred-fence-${name}-`));
  try {
    mkdirSync(outDir, { recursive: true });
    const entry = join(dir, file);
    writeFileSync(entry, source);
    const outPath = join(outDir, name);
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return outPath;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(binary: string, env: Record<string, string> = {}): Promise<Run> {
  try {
    const pending = execFileAsync(binary, [], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

// `RegExp.prototype.compile` has no lowering (SC2020): each call below is a
// runtime fence. Two sites, the first reached three times.
const SWALLOWED = `"use strict";
function recompile(pattern) {
  try {
    const target = new RegExp("a");
    target.compile(pattern);
    return "compiled";
  } catch (e) {
    return "caught " + (e instanceof Error) + " " + e.code;
  }
}
for (const pattern of ["b", "c", "d"]) console.log(recompile(pattern));
try {
  /x/.compile("y");
} catch {
  console.log("caught again");
}
console.log("done");
`;

const HINT =
  "scriptc: this program reached code that scriptc could not compile; each such operation throws where it runs and is reported here once ('scriptc coverage' lists them, SCRIPTC_DEFERRED_REPORT=0 silences these lines)";

test("a caught deferred refusal is reported once per site on stderr", async () => {
  const binary = await build("swallowed", "main.js", SWALLOWED);
  const result = await run(binary);
  expect(result.stdout).toBe(
    "caught true SC2020\ncaught true SC2020\ncaught true SC2020\ncaught again\ndone\n",
  );
  expect(result.exitCode).toBe(0);
  const lines = result.stderr.split("\n").filter((line) => line !== "");
  expect(lines).toEqual([
    HINT,
    expect.stringMatching(/^scriptc: not compiled: .*compile.* \[SC2020 at .*main\.js:5\]$/),
    expect.stringMatching(/^scriptc: not compiled: .*compile.* \[SC2020 at .*main\.js:13\]$/),
  ]);
}, 300_000);

test("SCRIPTC_DEFERRED_REPORT=0 silences the report and nothing else", async () => {
  const binary = await build("swallowed", "main.js", SWALLOWED);
  const result = await run(binary, { SCRIPTC_DEFERRED_REPORT: "0" });
  expect(result).toEqual({
    stdout: "caught true SC2020\ncaught true SC2020\ncaught true SC2020\ncaught again\ndone\n",
    stderr: "",
    exitCode: 0,
  });
}, 300_000);

test("an uncaught deferred refusal is reported before the uncaught error", async () => {
  const binary = await build("uncaught", "main.js", `"use strict";\n/x/.compile("y");\n`);
  const result = await run(binary);
  expect(result.exitCode).toBe(1);
  const lines = result.stderr.split("\n").filter((line) => line !== "");
  expect(lines).toEqual([
    HINT,
    expect.stringMatching(/^scriptc: not compiled: .* \[SC2020 at .*main\.js:2\]$/),
    expect.stringMatching(/^Uncaught Error: .* \[SC2020 at .*main\.js:2\]$/),
  ]);
}, 300_000);

// Sanitized builds keep their symbols under other link flags; the plain
// lane's executable answers the question.
test.skipIf(sanitize || process.platform === "win32")(
  "a program without a deferred refusal does not link the reporter",
  async () => {
    const defined = (binary: string): boolean =>
      /\bscr_deferred_fence\b/.test(execFileSync("nm", [binary], { encoding: "utf8" }));
    const clean = await build("clean", "main.ts", `console.log("no fence here");\n`);
    const fenced = await build("swallowed", "main.js", SWALLOWED);
    expect(defined(fenced)).toBe(true);
    expect(defined(clean)).toBe(false);
  },
  300_000,
);
