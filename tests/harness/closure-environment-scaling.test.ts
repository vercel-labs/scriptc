/* Compile time stays linear in the size of a closure environment. A factory
 * whose methods share thousands of captured bindings (the shape of Bun's
 * large-environment AOT program) used to take minutes: capture analyses
 * walked the whole body once per binding, and LLVM received every box
 * pointer as a value live across the entire function. Behavior of such a
 * program is pinned by corpus 5973; this test bounds how compile time grows
 * between two generated sizes. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
// Sanitized builds compile the runtime with each uncached build, which
// dwarfs both sizes; the growth this test bounds is the same in every lane.
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** `n` number bindings plus n/20 objects and strings, all captured by a
 * reader and a writer method, and the output the program prints. */
function program(n: number): { source: string; expected: string } {
  const lines = [
    `function total(list: number[]): number {`,
    `  let t = 0;`,
    `  for (const v of list) t += v;`,
    `  return t;`,
    `}`,
    `const one = Number("1");`,
    `function make() {`,
  ];
  const reads: string[] = [];
  const writes: string[] = [];
  let sum = 0;
  let bumped = 0;
  for (let i = 0; i < n; i++) {
    lines.push(`  let n${i} = ${i} + 0.5;`);
    reads.push(`n${i}`);
    writes.push(`n${i} += 1;`);
    sum += i + 0.5;
    bumped += i + 1.5;
  }
  for (let i = n; i < n + n / 10; i++) {
    if (i % 2 === 0) {
      lines.push(`  let o${i} = { x: ${i} };`);
      reads.push(`o${i}.x`);
      writes.push(`o${i} = { x: o${i}.x + 1 };`);
      sum += i;
      bumped += i + 1;
    } else {
      lines.push(`  let s${i} = "s" + (${i} + one);`);
      reads.push(`s${i}.length`);
      writes.push(`s${i} += "!";`);
      const length = `s${i + 1}`.length;
      sum += length;
      bumped += length + 1;
    }
  }
  lines.push(
    `  return {`,
    `    sum(): number {`,
    `      return total([${reads.join(", ")}]);`,
    `    },`,
    `    bump(): void {`,
    ...writes.map((write) => `      ${write}`),
    `    },`,
    `  };`,
    `}`,
    `const a = make();`,
    `const b = make();`,
    `a.bump();`,
    `console.log(a.sum(), b.sum());`,
  );
  return { source: lines.join("\n") + "\n", expected: `${bumped} ${sum}\n` };
}

/** Milliseconds from the end of the frontend load to the finished
 * executable (SCRIPTC_TIMING phases): lowering, IR passes, LLVM emission,
 * native code generation and the link, without process and tsgo startup. */
async function compileTime(dir: string, n: number): Promise<number> {
  const { source, expected } = program(n);
  const entry = join(dir, `env${n}.ts`);
  const binary = join(dir, `env${n}`);
  writeFileSync(entry, source);
  const { stderr } = await execFileAsync(
    process.execPath,
    [join(repoRoot, "packages/cli/dist/main.js"), "build", entry, "-o", binary],
    {
      env: { ...process.env, SCRIPTC_TIMING: "1", SCRIPTC_NO_CACHE: "1" },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const phases = new Map<string, number>();
  for (const line of stderr.split("\n")) {
    if (!line.startsWith("scriptc timing ")) continue;
    const { phase, total_ms } = JSON.parse(line.slice("scriptc timing ".length)) as {
      phase: string;
      total_ms: number;
    };
    phases.set(phase, total_ms);
  }
  const loaded = phases.get("frontend-load");
  const complete = phases.get("complete");
  if (loaded === undefined || complete === undefined) throw new Error(stderr);
  const run = await execFileAsync(binary, [], { encoding: "utf8" });
  expect(run.stdout).toBe(expected);
  return complete - loaded;
}

test.skipIf(sanitize)(
  "compile time grows linearly with a shared closure environment",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-closure-scaling-"));
    try {
      const small = await compileTime(dir, 500);
      const large = await compileTime(dir, 4000);
      // Eight times the bindings. Linear growth stays at or below 8x (fixed
      // costs keep it near 5x); the quadratic analyses and code generation
      // measured 24x at these sizes, and every doubling beyond adds 4x.
      expect(large / small, `${small.toFixed(0)} ms -> ${large.toFixed(0)} ms`).toBeLessThan(16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
