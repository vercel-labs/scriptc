/* console.trace — the line Node prints, then scriptc's own frames.
 *
 * The differential corpus compares stdout and stderr byte for byte, and a
 * trace's frame block cannot match: Node's stack carries the module
 * loader's frames and names its call sites by byte column, while scriptc
 * prints the compiled program's own function and file text (SEMANTICS.md
 * divergence 11, as an uncaught Error's report does). What HAS to match
 * Node is everything before the frames: the "Trace[: args]" line, which
 * stream it lands on, the formatting of every argument, and the frames'
 * existence under Error.stackTraceLimit. These pins run the same source
 * under Node for the deterministic part and hold scriptc's frame block to
 * its own shape.
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit like every harness
 * lane.
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

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Compiles an inline program, runs it, and runs the same source under the
 * pinned Node so the deterministic part of the output can be compared with
 * the oracle. `debug` keeps the compiled frames readable (a dev build has
 * the source lines the frames name). */
async function runBoth(
  name: string,
  source: string,
  optimization: "dev" | "release" = "dev",
): Promise<{ native: RunResult; node: RunResult }> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .update(optimization)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `console-trace-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.cjs`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
    optimization,
  });
  if (!result.ok) {
    throw new Error(
      "console.trace program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "utf8" });
      return { stdout, stderr: stripAsanFiberWarning(stderr), exitCode: 0 };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof e.code !== "number") throw err;
      return {
        stdout: e.stdout ?? "",
        stderr: stripAsanFiberWarning(e.stderr ?? ""),
        exitCode: e.code,
      };
    }
  };
  return {
    native: await run(result.binaryPath, []),
    node: await run(process.execPath, [file]),
  };
}

/** An ASan warning the fiber swapcontext interceptor prints to stderr on
 * Linux; sanitizer noise, never program output. */
function stripAsanFiberWarning(s: string): string {
  return s.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

/** The "Trace..." lines of a trace's stderr, in order. */
function traceLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.startsWith("Trace"));
}

/** The frame lines of a trace's stderr: everything that is neither a
 * "Trace..." line nor blank. */
function frameLines(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line !== "" && !line.startsWith("Trace"));
}

describe(`console.trace (scriptc frames${sanitize ? ", sanitized" : ""})`, () => {
  test("the Trace line matches Node and the frames are the program's own", async () => {
    const { native, node } = await runBoth(
      "trace-args",
      `function inner(n) { console.trace("value", n, { a: 1 }, null, undefined, true); }
function outer() { inner(7); }
outer();
`,
    );
    expect(native.exitCode).toBe(0);
    expect(native.stdout).toBe("");
    expect(traceLines(native.stderr)).toEqual(["Trace: value 7 { a: 1 } null undefined true"]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
    const frames = frameLines(native.stderr);
    expect(frames.length).toBeGreaterThan(0);
    for (const line of frames) {
      expect(line.startsWith("    at ")).toBe(true);
      // A sanitized dev build keeps no positions (positioned frames off,
      // like a release build), so only the plain dev build can name the
      // statement.
      if (!sanitize) expect(line).toMatch(/:\d+:\d+\)?$/);
    }
    // The nearest frame is the function that called console.trace, and the
    // caller above it follows: the frame block is the program's call chain.
    expect(frames[0]).toContain("inner");
    expect(frames[1]).toContain("outer");
  });

  test("an empty call prints Trace alone", async () => {
    const { native, node } = await runBoth(
      "trace-empty",
      `console.trace();
`,
    );
    expect(traceLines(native.stderr)).toEqual(["Trace"]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
  });

  test("a format string and template parts format as Node does", async () => {
    const { native, node } = await runBoth(
      "trace-format",
      `const n = 3;
console.trace("%s=%d", "x", n);
console.trace(\`n=\${n}\`);
`,
    );
    expect(traceLines(native.stderr)).toEqual(["Trace: x=3", "Trace: n=3"]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
  });

  test("Error.stackTraceLimit = 0 keeps the line and drops the frames", async () => {
    const { native, node } = await runBoth(
      "trace-limit",
      `Error.stackTraceLimit = 0;
console.trace("bare");
`,
    );
    expect(native.stderr).toBe("Trace: bare\n");
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
  });

  test("an empty formatted message prints Trace alone", async () => {
    const { native, node } = await runBoth(
      "trace-empty-message",
      // A named function: a sanitized build keeps frames only where a
      // function names them, and the frame assertion below holds in both
      // lanes.
      `function emit() {
  console.trace("");
  console.trace("%s", "");
  console.trace("", "");
}
emit();
`,
    );
    expect(traceLines(native.stderr)).toEqual(["Trace", "Trace", "Trace:  "]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
    expect(frameLines(native.stderr).length).toBeGreaterThan(0);
  });

  test("a patched stderr receives one write whose frames the hook cannot change", async () => {
    const { native, node } = await runBoth(
      "trace-one-write",
      `let writes = 0;
let head = "";
let frames = 0;
process.stderr.write = function (chunk) {
  writes++;
  const lines = String(chunk).split("\\n");
  if (head === "") head = lines[0];
  for (const line of lines) if (line.startsWith("    at ")) frames++;
  Error.stackTraceLimit = 0;
  return true;
};
function inner() { console.trace("limit"); }
inner();
process.stdout.write(writes + " " + head + " " + (frames > 0) + "\\n");
`,
    );
    // One call, the whole trace; the frames were captured when the call ran,
    // so the hook's Error.stackTraceLimit = 0 changes nothing.
    expect(native.stdout).toBe("1 Trace: limit true\n");
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe("");
    expect(node.stderr).toBe("");
  });

  test("a release build prints its frames", async () => {
    const { native, node } = await runBoth(
      "trace-release",
      `function inner() { console.trace("release"); }
function outer() { inner(); }
outer();
`,
      "release",
    );
    expect(native.stdout).toBe("");
    expect(traceLines(native.stderr)).toEqual(["Trace: release"]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
    const frames = frameLines(native.stderr);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toContain("inner");
    expect(frames[1]).toContain("outer");
  });

  test("arguments evaluate in source order before the write, and stdout stays clean", async () => {
    const { native, node } = await runBoth(
      "trace-order",
      `function mark(n) { console.log("mark " + n); return n; }
console.trace(mark(1), mark(2));
console.log("after");
`,
    );
    expect(native.stdout).toBe("mark 1\nmark 2\nafter\n");
    expect(native.stdout).toBe(node.stdout);
    expect(traceLines(native.stderr)).toEqual(["Trace: 1 2"]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
  });

  test("a Console instance writes the line and the frames to its own stderr", async () => {
    const { native, node } = await runBoth(
      "trace-instance",
      `const { Console } = require("node:console");
const c = new Console(process.stdout, process.stderr);
function inner(n) { c.trace("value", n); }
function outer() { inner(7); }
outer();
`,
    );
    expect(native.exitCode).toBe(0);
    expect(native.stdout).toBe("");
    expect(traceLines(native.stderr)).toEqual(["Trace: value 7"]);
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
    // The frames are the program's call chain, as the global console's are.
    const frames = frameLines(native.stderr);
    expect(frames[0]).toContain("inner");
    expect(frames[1]).toContain("outer");
  });

  test("an instance's frames follow Error.stackTraceLimit when the call runs", async () => {
    const { native, node } = await runBoth(
      "trace-instance-limit",
      `const { Console } = require("node:console");
const c = new Console(process.stdout, process.stderr);
Error.stackTraceLimit = 0;
c.trace("bare");
`,
    );
    expect(native.stderr).toBe("Trace: bare\n");
    expect(traceLines(native.stderr)).toEqual(traceLines(node.stderr));
  });
});
