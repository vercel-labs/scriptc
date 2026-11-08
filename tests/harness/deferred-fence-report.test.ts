/* The report of a deferred refusal. A JavaScript statement that does not
 * compile becomes a throw of its diagnostic at the operation that reaches it
 * (a runtime fence). The Error is catchable, so a handler above it, the
 * program's or a framework's, could turn a compiler gap into a wrong answer
 * with nothing said anywhere.
 *
 * Where the report goes depends on where the site is. A site that sits in the
 * `try` block of a `try`/`catch` of its own function has the program's
 * handler for exactly that statement: the build names it (warning SC6012) and
 * the binary writes nothing, so a program that guards an optional call keeps
 * Node's stderr. Every other site is named on stderr the first time it fires
 * (scr_deferred_fence.c). SCRIPTC_DEFERRED_REPORT=all reports the guarded
 * sites at run time too, SCRIPTC_DEFERRED_REPORT=0 silences every site, and a
 * program without such a site does not link the unit.
 *
 * These cannot be corpus programs: the suites run with the report off, and
 * under Node the fenced operation works. */
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

interface Built {
  binary: string;
  /** The SC6012 warnings of the build: line and message of each. */
  guarded: { line: number; message: string }[];
}

async function buildWith(name: string, file: string, source: string): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-deferred-fence-${name}-`));
  try {
    mkdirSync(outDir, { recursive: true });
    const entry = join(dir, file);
    writeFileSync(entry, source);
    const outPath = join(outDir, name);
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const warnings = "warnings" in result ? (result.warnings ?? []) : [];
    return {
      binary: outPath,
      guarded: warnings
        .filter((w) => w.code === "SC6012")
        .map((w) => ({
          line: source.slice(0, w.loc.start).split("\n").length,
          message: w.message,
        })),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function build(name: string, file: string, source: string): Promise<string> {
  return (await buildWith(name, file, source)).binary;
}

/** The same source under Node. */
async function node(file: string, source: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-deferred-fence-node-"));
  try {
    const entry = join(dir, file);
    writeFileSync(entry, source);
    const { stdout, stderr } = await execFileAsync(process.execPath, [entry], { encoding: "utf8" });
    return { stdout, stderr, exitCode: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(binary: string, env: Record<string, string> = {}): Promise<Run> {
  try {
    const pending = execFileAsync(binary, [], {
      encoding: "utf8",
      // The suites run compiled programs with the report off
      // (vitest.config.ts); these tests are about the report.
      env: { ...process.env, SCRIPTC_DEFERRED_REPORT: "1", ...env },
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
// runtime fence. The sites are in functions of their own, so the `try` that
// catches them is their caller's, the way a framework's handler is: two
// sites, the first reached three times.
const SWALLOWED = `"use strict";
function recompile(pattern) {
  const target = new RegExp("a");
  target.compile(pattern);
  return "compiled";
}
function again() {
  /x/.compile("y");
}
for (const pattern of ["b", "c", "d"]) {
  try {
    console.log(recompile(pattern));
  } catch (e) {
    console.log("caught " + (e instanceof Error) + " " + e.code);
  }
}
try {
  again();
} catch {
  console.log("caught again");
}
console.log("done");
`;

const HINT =
  "scriptc: this program reached code that scriptc could not compile; each such operation throws where it runs and is reported here once ('scriptc coverage' lists them, SCRIPTC_DEFERRED_REPORT=0 silences these lines)";

const reportLines = (stderr: string): string[] => stderr.split("\n").filter((line) => line !== "");
const siteLine = (file: string, line: number): unknown =>
  expect.stringMatching(
    new RegExp(`^scriptc: not compiled: .*compile.* \\[SC2020 at .*${file}:${line}\\]$`),
  );

test("a deferred refusal caught by a caller is reported once per site on stderr", async () => {
  const built = await buildWith("swallowed", "main.js", SWALLOWED);
  expect(built.guarded).toEqual([]);
  const result = await run(built.binary);
  expect(result.stdout).toBe(
    "caught true SC2020\ncaught true SC2020\ncaught true SC2020\ncaught again\ndone\n",
  );
  expect(result.exitCode).toBe(0);
  expect(reportLines(result.stderr)).toEqual([
    HINT,
    siteLine("main\\.js", 4),
    siteLine("main\\.js", 8),
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

// The first statements of a command-line tool: an optional call the program
// guards itself, then its own output on both streams.
const GUARDED_SAME = `"use strict";
try {
  /x/.compile("y");
} catch {}
console.error("tool 1.2.3");
console.log("1.2.3");
`;

test("a refusal inside its own try/catch prints nothing: stdout and stderr equal Node's", async () => {
  const built = await buildWith("guarded-same", "main.js", GUARDED_SAME);
  const result = await run(built.binary);
  expect(result).toEqual(await node("main.js", GUARDED_SAME));
  expect(result).toEqual({ stdout: "1.2.3\n", stderr: "tool 1.2.3\n", exitCode: 0 });
  // The build names the site instead.
  expect(built.guarded.map((w) => w.line)).toEqual([3]);
  expect(built.guarded[0]!.message).toContain("SC2020");
  expect(built.guarded[0]!.message).toContain("inside its own try block");
  expect(built.guarded[0]!.message).toContain(
    "the catch clause runs, also where the statement would have completed under Node",
  );
}, 300_000);

// The catch records the failure and the program prints which path it took:
// the binary's output differs from Node's, as it does without the report.
const GUARDED_OTHER_PATH = `"use strict";
let state = "compiled";
try {
  /x/.compile("y");
} catch {
  state = "not compiled";
}
console.log(state);
`;

test("a guarded refusal whose catch takes another path is named by the build, not by the binary", async () => {
  const built = await buildWith("guarded-other-path", "main.js", GUARDED_OTHER_PATH);
  expect(built.guarded.map((w) => w.line)).toEqual([4]);
  expect(built.guarded[0]!.message).toContain("the program's output can differ from Node's");
  const result = await run(built.binary);
  expect(result).toEqual({ stdout: "not compiled\n", stderr: "", exitCode: 0 });
  expect((await node("main.js", GUARDED_OTHER_PATH)).stdout).toBe("compiled\n");
  // Asked for every site, the binary names it.
  const all = await run(built.binary, { SCRIPTC_DEFERRED_REPORT: "all" });
  expect(all.stdout).toBe("not compiled\n");
  expect(reportLines(all.stderr)).toEqual([HINT, siteLine("main\\.js", 4)]);
  const none = await run(built.binary, { SCRIPTC_DEFERRED_REPORT: "0" });
  expect(none).toEqual({ stdout: "not compiled\n", stderr: "", exitCode: 0 });
}, 300_000);

// What "its own try" means. Guarded: through blocks, loops and an inner try
// with only a finally (lines 5 and 12). Not guarded: a try with only a
// finally (16), a catch block (23), a finally block (30), a function called
// from the try block (34) and a function written inside it (41).
const LEXICAL = `"use strict";
function nestedFinally() {
  try {
    try {
      for (let i = 0; i < 2; i++) { if (i === 1) /x/.compile("y"); }
    } finally {
      console.log("inner finally");
    }
  } catch { console.log("guarded by the outer catch"); }
}
function innerCatch() {
  try { try { /x/.compile("y"); } catch { console.log("guarded by the inner catch"); } } finally { console.log("outer finally"); }
}
function onlyFinally() {
  try {
    /x/.compile("y");
  } finally {
    console.log("only finally");
  }
}
function inCatchBlock() {
  try { throw new Error("first"); } catch {
    /x/.compile("y");
  }
}
function inFinallyBlock() {
  try {
    console.log("body");
  } finally {
    /x/.compile("y");
  }
}
function called() {
  /x/.compile("y");
}
function callsIt() {
  try { called(); } catch { console.log("caught from a called function"); }
}
function writtenInside() {
  try {
    const tune = () => { /x/.compile("y"); };
    tune();
  } catch { console.log("caught from a function written inside the try"); }
}
nestedFinally();
innerCatch();
try { onlyFinally(); } catch { console.log("caught outside onlyFinally"); }
try { inCatchBlock(); } catch { console.log("caught outside inCatchBlock"); }
try { inFinallyBlock(); } catch { console.log("caught outside inFinallyBlock"); }
callsIt();
writtenInside();
`;

test("only a site in the try block of a try/catch of its own function is guarded", async () => {
  const built = await buildWith("lexical", "main.js", LEXICAL);
  expect(built.guarded.map((w) => w.line).sort((a, b) => a - b)).toEqual([5, 12]);
  const result = await run(built.binary);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    [
      "inner finally",
      "guarded by the outer catch",
      "guarded by the inner catch",
      "outer finally",
      "only finally",
      "caught outside onlyFinally",
      "caught outside inCatchBlock",
      "body",
      "caught outside inFinallyBlock",
      "caught from a called function",
      "caught from a function written inside the try",
      "",
    ].join("\n"),
  );
  expect(reportLines(result.stderr)).toEqual([
    HINT,
    siteLine("main\\.js", 16),
    siteLine("main\\.js", 23),
    siteLine("main\\.js", 30),
    siteLine("main\\.js", 34),
    siteLine("main\\.js", 41),
  ]);
  const all = await run(built.binary, { SCRIPTC_DEFERRED_REPORT: "all" });
  expect(reportLines(all.stderr)).toEqual([
    HINT,
    siteLine("main\\.js", 5),
    siteLine("main\\.js", 12),
    siteLine("main\\.js", 16),
    siteLine("main\\.js", 23),
    siteLine("main\\.js", 30),
    siteLine("main\\.js", 34),
    siteLine("main\\.js", 41),
  ]);
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
