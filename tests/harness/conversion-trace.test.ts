/* SCRIPTC_CONVERSION_TRACE: a dev build's report of failed checked
 * conversions (scr_conversion_trace.c).
 *
 * A checked conversion throws a TypeError where Node.js checks nothing, so
 * a program that catches the error without looking at it takes another
 * path than under Node.js and says nothing. The report writes each failure
 * to stderr when it happens, with the conversion's source position. Node
 * has no such output, and the corpus compares stderr with Node's, so these
 * are scriptc-only pins: the report's text, that it is off unless asked
 * for, and that a release build has none.
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit like every harness lane.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Build {
  optimization?: "dev";
  strip?: true;
}

async function build(name: string, source: string, options: Build): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(JSON.stringify(options))
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `conversion-trace-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
    ...options,
  });
  if (!result.ok) {
    throw new Error(
      "conversion-trace program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `binary` with SCRIPTC_CONVERSION_TRACE set to `trace`, or unset. */
async function run(binary: string, trace: string | undefined): Promise<RunResult> {
  const env = { ...process.env };
  delete env["SCRIPTC_CONVERSION_TRACE"];
  if (trace !== undefined) env["SCRIPTC_CONVERSION_TRACE"] = trace;
  try {
    const { stdout, stderr } = await execFileAsync(binary, [], { encoding: "utf8", env });
    return { stdout, stderr: clean(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: clean(e.stderr ?? ""), exitCode: e.code };
  }
}

/** stderr without the sanitizer's once-per-process fiber warning, and with
 * the directory removed from every path. */
function clean(stderr: string): string {
  return stderr
    .replace(/^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm, "")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s()]*[\\/]/g, "");
}

// Lines of a log, read into a record type inside a `try` whose handler
// means "skip a malformed line". The second line is well-formed and lacks a
// member the type declares; the third is not JSON.
const skipped = `interface Usage {
  input: number;
  total: number;
}
interface Entry {
  type: "message";
  usage: Usage;
}
function parse(line: string): Entry | null {
  try {
    return JSON.parse(line) as Entry;
  } catch {
    return null;
  }
}
const lines = [
  '{"type":"message","usage":{"input":1,"total":2}}',
  '{"type":"message","usage":{"input":1}}',
  "not json",
];
for (const line of lines) {
  const entry = parse(line);
  console.log(entry === null ? "skipped" : entry.type + " " + entry.usage.input);
}
`;

// Two workers that fail their first conversion at the same moment, each
// through the same `try` whose handler means "no total".
const workers = `import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
interface Usage {
  total: number;
}
function totalOf(text: string): string {
  try {
    return typeof (JSON.parse(text) as Usage).total;
  } catch {
    return "undefined";
  }
}
if (isMainThread) {
  const gate = new SharedArrayBuffer(4);
  const answers: string[] = [];
  let left = 2;
  for (let i = 0; i < 2; i++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: gate });
    worker.on("message", (answer: string) => answers.push(answer));
    worker.on("exit", () => {
      left -= 1;
      if (left === 0) console.log("workers", answers.join(" "));
    });
  }
} else {
  const view = new Int32Array(workerData as SharedArrayBuffer);
  Atomics.add(view, 0, 1);
  while (Atomics.load(view, 0) < 2) {}
  parentPort!.postMessage(totalOf('{"input":1}'));
}
`;

describe(`SCRIPTC_CONVERSION_TRACE (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("a dev build reports a failed conversion the program catches", async () => {
    const binary = await build("skipped", skipped, { optimization: "dev" });
    const traced = await run(binary, "1");
    expect(traced.exitCode).toBe(0);
    // The program runs as it does without the report.
    expect(traced.stdout).toBe("message 1\nskipped\nskipped\n");
    // One report, for the line that is not an Entry. The line that is not
    // JSON fails with a SyntaxError, which is no conversion's failure.
    expect(traced.stderr).toBe(
      [
        "scriptc: checked conversion failed: TypeError: expected number at $.usage.total, got undefined",
        "    at parse (skipped.ts:11:12)",
        "",
      ].join("\n"),
    );
  });

  test("the report is off unless the variable is set", async () => {
    const binary = await build("skipped", skipped, { optimization: "dev" });
    for (const trace of [undefined, "", "0"]) {
      const r = await run(binary, trace);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("message 1\nskipped\nskipped\n");
      expect(r.stderr).toBe("");
    }
  });

  test("two workers that fail their first conversion together both report", async () => {
    const binary = await build("workers", workers, { optimization: "dev" });
    const r = await run(binary, "1");
    expect(r.exitCode).toBe(0);
    // The program runs as it does without the report.
    expect(r.stdout).toBe("workers undefined undefined\n");
    // Each thread reports its own failure. A report is written in separate
    // pieces (the prefix, then the error text, then the frame, with the
    // newlines written on their own), so two threads can interleave at any
    // of those boundaries, inside a line as well as between lines. Each
    // piece is counted on its own, after the newlines are dropped: every one
    // must be there twice, and nothing else may be.
    const pieces = [
      "scriptc: checked conversion failed: ",
      "TypeError: expected number at $.total, got undefined",
      "    at totalOf (workers.ts:7:20)",
    ];
    const joined = r.stderr.replace(/\n/g, "");
    for (const piece of pieces) expect(joined.split(piece).length - 1).toBe(2);
    expect(joined.length).toBe(2 * pieces.reduce((n, piece) => n + piece.length, 0));
    // The same failures with the variable unset write nothing, and leave
    // the program's output as it is.
    const off = await run(binary, undefined);
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toBe("workers undefined undefined\n");
    expect(off.stderr).toBe("");
  });

  test("a release build and a stripped dev build have no report", async () => {
    for (const options of [{}, { optimization: "dev", strip: true }] as Build[]) {
      const binary = await build("skipped", skipped, options);
      const r = await run(binary, "1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("message 1\nskipped\nskipped\n");
      expect(r.stderr).toBe("");
    }
  });

  test("an uncaught failure is reported before the uncaught error", async () => {
    const binary = await build(
      "uncaught",
      `const port: number = JSON.parse('{"port":"8080"}').port;
console.log(port);
`,
      { optimization: "dev" },
    );
    const r = await run(binary, "1");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    const lines = r.stderr.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "scriptc: checked conversion failed: TypeError: expected number at $, got string",
      "    at uncaught.ts:1:22",
      "Uncaught TypeError: expected number at $, got string",
    ]);
  });

  test("a check deferred to the read of a dictionary view is reported at the read", async () => {
    // A value cast from \`unknown\` to a dictionary type keeps its identity
    // and is not validated by the cast: the read of a member is.
    const binary = await build(
      "view",
      `const box = { value: JSON.parse('{"a":"x"}') as unknown };
try {
  const view = box.value as Record<string, number>;
  console.log("view", view.a + 1);
} catch {
  console.log("view caught");
}
`,
      { optimization: "dev" },
    );
    const r = await run(binary, "1");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("view caught\n");
    expect(r.stderr).toBe(
      [
        "scriptc: checked conversion failed: TypeError: expected number at $, got string",
        "    at view.ts:4:23",
        "",
      ].join("\n"),
    );
  });

  test("methods, async functions and several conversions in one statement", async () => {
    const binary = await build(
      "places",
      `interface Point {
  x: number;
  y: number;
}
class Store {
  read(text: string): Point | undefined {
    try {
      return JSON.parse(text) as Point;
    } catch {
      return undefined;
    }
  }
}
async function load(text: string): Promise<Point> {
  await Promise.resolve();
  return JSON.parse(text) as Point;
}
function both(a: string, b: string): number {
  try {
    return (JSON.parse(a) as Point).x + (JSON.parse(b) as Point).y;
  } catch {
    return -1;
  }
}
console.log(new Store().read('{"x":1}'));
console.log(both('{"x":1,"y":2}', '{"x":1}'));
console.log(await load('{"y":2}').catch(() => "rejected"));
`,
      { optimization: "dev" },
    );
    const r = await run(binary, "1");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("undefined\n-1\nrejected\n");
    expect(r.stderr).toBe(
      [
        "scriptc: checked conversion failed: TypeError: expected number at $.y, got undefined",
        "    at Store.read (places.ts:8:14)",
        "scriptc: checked conversion failed: TypeError: expected number at $.y, got undefined",
        "    at both (places.ts:20:42)",
        "scriptc: checked conversion failed: TypeError: expected number at $.x, got undefined",
        "    at load (places.ts:16:10)",
        "",
      ].join("\n"),
    );
  });
});
