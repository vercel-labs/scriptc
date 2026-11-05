import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-localized-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// A statement that lowers again after a later declarator degrades a type
// reuses the member bodies of a function-local class it lowered the first
// time, so the diagnostics of those bodies still report.
test("a degrading retry keeps the diagnostics of a local class lowered before it", async () => {
  const result = await compileSource(`type Progress = (done: number, total: number) => void;
type Callbacks = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;
function make(): number {
  const K = class {
      m(): number {
        const a = [1, 2];
        (a as any).foo = 1;
        return a.length;
      }
    },
    size = (cb: Callbacks): number => (cb instanceof Set ? cb.size : 0);
  return new K().m() + size(new Set([1]));
}
console.log(make());
`);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the local class's diagnostic");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "SC1090",
        message: expect.stringContaining("assignment to non-variables"),
      }),
    ]),
  );
});

// Without the failing statement, the same program compiles: the arrow's
// parameter is a dynamic slot.
test("the same program without the local class's failure compiles", async () => {
  const result = await compileSource(`type Progress = (done: number, total: number) => void;
type Callbacks = Progress | AbortSignal | Map<string, (x: number) => string> | Set<number>;
function make(): number {
  const K = class {
      m(): number {
        return 2;
      }
    },
    size = (cb: Callbacks): number => (cb instanceof Set ? cb.size : 0);
  return new K().m() + size(new Set([1]));
}
console.log(make());
`);
  expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
});
