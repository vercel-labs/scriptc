import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-callback-versions-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const body = (llvm: string, marker: string): string => {
  const match = new RegExp(`^define internal [^\\n]*${marker}[^]*?^}`, "m").exec(llvm);
  if (!match) throw new Error(`no function ${marker}`);
  return match[0];
};

test("loops that call a known callback test its closure once and call it directly", async () => {
  const llvm = await emitLlvm(`
    function each(values: number[], visit: (v: number) => void): void {
      for (let i = 0; i < values.length; i++) visit(values[i]!);
    }
    let sum = 0;
    each([1, 2, 3], (v) => { sum += v; });
    console.log(sum);
  `);
  const fn = body(llvm, "@sc_bf_each");
  const fast = /^callback\.version\.fast\d+:$[^]*?^callback\.version\.done\d+:$/m.exec(fn)![0];
  // The guard compares the closure's code pointer once, before the loop.
  expect(fn.slice(0, fn.indexOf(fast))).toMatch(/icmp eq ptr %\S+, @/);
  expect(fast).not.toContain("callback.indirect");
  expect(fast).not.toContain("scr_dyn_this_push_dyn");
  // The ordinary copy keeps the fallback through the closure's pointer.
  expect(fn).toContain("callback.indirect");
});

test("captured number payloads carry their own alias tag", async () => {
  const llvm = await emitLlvm(`
    function total(values: number[]): number {
      let sum = 0;
      values.forEach((v) => { sum += v; });
      return sum;
    }
    console.log(total([1, 2, 3]));
  `);
  // Every read and write through a box's payload slot (field 5) is tagged.
  const slots = [
    ...llvm.matchAll(/(%\S+) = getelementptr inbounds %ScrBox, ptr %\S+, i32 0, i32 5/g),
  ];
  expect(slots.length).toBeGreaterThan(0);
  for (const [, slot] of slots) {
    for (const access of llvm.matchAll(
      new RegExp(`(load double, ptr|store double %\\S+, ptr) \\${slot}\\b[^\\n]*`, "g"),
    ))
      expect(access[0]).toMatch(/!tbaa !\d+$/);
  }
  expect(llvm).toMatch(/load double, ptr %\S+, !tbaa !\d+/);
});

test("a callback declared in the loop body is not read before the loop", async () => {
  const llvm = await emitLlvm(`
    function strides(): number {
      let calls = 0;
      for (let i = 0; i < 10; i++) {
        const bump = (): void => { i += 2; };
        bump();
        calls++;
      }
      return calls;
    }
    console.log(strides());
  `);
  expect(llvm).not.toContain("callback.version");
});

test("loops inside a callback version are not versioned again", async () => {
  // Each inner loop calls a callback a factory builds just before it; without
  // the limit, every copy of a version would version the next loop again.
  const llvm = await emitLlvm(`
    function adder(k: number): (v: number) => number {
      return (v: number) => v + k;
    }
    function nest(n: number, f: (v: number) => number): number {
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += f(i);
        const g = adder(i);
        for (let j = 0; j < n; j++) {
          s += g(j);
          const h = adder(j);
          for (let k = 0; k < n; k++) s += h(k);
        }
      }
      return s;
    }
    console.log(nest(3, (v) => v - 1), nest(2, (v) => v * 3));
  `);
  // One version for the outer loop of each compiled `nest`; its two copies
  // keep the inner loops whole.
  const versions = [...llvm.matchAll(/^define [^\n]*@sc_bf_nest[^]*?^}/gm)].map(
    ([body]) => body.match(/^callback\.version\.fast\d+:$/gm)?.length ?? 0,
  );
  expect(versions.every((count) => count <= 1)).toBe(true);
  expect(versions.some((count) => count === 1)).toBe(true);
});
