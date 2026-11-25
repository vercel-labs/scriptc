/* Compile time stays linear in the values one statement holds while its
 * steps can throw. A dynamic object literal with n members keeps every
 * member's value alive until the statement ends, and each member's store is
 * a throw site that releases the values made so far: written out at every
 * site that is n²/2 release calls (6 MB of LLVM text for a table of 500
 * names), and LLVM then merges those blocks into as many phi nodes, which
 * cost it minutes. Throw sites that hold many values share their release
 * blocks instead (emitUnwind). Behavior is pinned by the corpus programs
 * unwind-many-held-values and unwind-many-held-values-dynamic; this test
 * bounds how the emitted text and the compile time grow between two
 * generated sizes. */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
// Sanitized builds compile the runtime with each uncached build, which
// dwarfs both sizes; the growth this test bounds is the same in every lane.
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const tone = (i: number): string => `#${((i * 2654435761) >>> 8).toString(16).padStart(6, "0")}`;
const members = (n: number, value: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => `    tone${i}: ${value(i)},`).join("\n");
const shade = [
  `function shade(i: number): string {`,
  `  if (i < 0) throw new RangeError("negative shade");`,
  `  return "#" + (i * 7919).toString(16);`,
  `}`,
].join("\n");

/** Programs of `n` values held by one statement, and what each prints. */
const shapes: Record<string, (n: number) => { source: string; expected: string }> = {
  // A table of names: the literal is the last statement of its function, so
  // its ordinary end and its throw sites reach the same return.
  "a dynamic table of strings": (n) => ({
    source: [
      `let table: any = null;`,
      `function fill(): void {`,
      `  table = {`,
      members(n, (i) => JSON.stringify(tone(i))),
      `  };`,
      `}`,
      `fill();`,
      `console.log(Object.keys(table).length, table.tone${n - 1});`,
    ].join("\n"),
    expected: `${n} ${tone(n - 1)}\n`,
  }),
  "a dynamic table of call results": (n) => ({
    source: [
      shade,
      `let table: any = null;`,
      `function fill(): void {`,
      `  table = {`,
      members(n, (i) => `shade(${i})`),
      `  };`,
      `}`,
      `fill();`,
      `console.log(Object.keys(table).length, table.tone${n - 1});`,
    ].join("\n"),
    expected: `${n} #${((n - 1) * 7919).toString(16)}\n`,
  }),
  "a dynamic list of call results": (n) => ({
    source: [
      shade,
      `const list: any = [`,
      Array.from({ length: n }, (_, i) => `  shade(${i}),`).join("\n"),
      `];`,
      `console.log(list.length, list[${n - 1}]);`,
    ].join("\n"),
    expected: `${n} #${((n - 1) * 7919).toString(16)}\n`,
  }),
};

function write(dir: string, shape: string, n: number): { entry: string; expected: string } {
  const { source, expected } = shapes[shape]!(n);
  const entry = join(dir, `${shape.replaceAll(" ", "-")}-${n}.ts`);
  writeFileSync(entry, source + "\n");
  return { entry, expected };
}

/** The release calls in the program's LLVM text. */
async function releaseCalls(dir: string, shape: string, n: number): Promise<number> {
  const { entry } = write(dir, shape, n);
  const llvm = `${entry}.ll`;
  await execFileAsync(process.execPath, [cli, "build", entry, "--emit", "llvm", "-o", llvm], {
    env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return readFileSync(llvm, "utf8").match(/call void @\w*release\w*\(/g)?.length ?? 0;
}

/** Milliseconds from the end of the frontend load to the finished
 * executable (SCRIPTC_TIMING phases), after checking what it prints. */
async function compileTime(dir: string, shape: string, n: number): Promise<number> {
  const { entry, expected } = write(dir, shape, n);
  const binary = `${entry}.bin`;
  const { stderr } = await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
    env: { ...process.env, SCRIPTC_TIMING: "1", SCRIPTC_NO_CACHE: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
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

test("the releases of a statement's throw sites grow linearly with the values it holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-unwind-scaling-"));
  try {
    for (const shape of Object.keys(shapes)) {
      const small = await releaseCalls(dir, shape, 150);
      const large = await releaseCalls(dir, shape, 600);
      // Four times the values. Shared release blocks add a few calls per
      // value (under 4x with the fixed part); written out at every throw
      // site, the calls grew 15x at these sizes.
      expect(large, shape).toBeLessThan(small * 5);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(sanitize)(
  "compile time grows linearly with the values a statement holds",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-unwind-scaling-"));
    try {
      const shape = "a dynamic table of strings";
      const small = await compileTime(dir, shape, 150);
      const large = await compileTime(dir, shape, 600);
      // Four times the values. Linear growth stays near 2x here, because the
      // fixed costs are most of the small build. Written out at every throw
      // site, the releases and the phi nodes LLVM merged them into took 6.6 s
      // of code generation at 100 values and 535 s at 400.
      expect(large).toBeLessThan(small * 8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  180_000,
);
