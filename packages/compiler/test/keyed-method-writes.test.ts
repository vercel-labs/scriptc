import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

async function lowerSource(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-keyed-writes-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Calls in `run` that go through a dynamic value. */
function dynamicCalls(mod: IrModule): number {
  const fn = mod.functions.find((f) => f.name === "run");
  if (!fn) throw new Error("no run function");
  let n = 0;
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "dynCall" || e.kind === "dynInvoke") n++;
      return true;
    },
    stmt: () => true,
  });
  return n;
}

const shape = `
type Step = "scale" | "clamp";
class Transform {
  scale(x: number): number {
    return x * 2;
  }
  clamp(x: number): number {
    return x < 0 ? 0 : x;
  }
}
`;

test("element writes of data under method names keep the methods native", async () => {
  const mod = await lowerSource(`${shape}
const enabled: Record<Step, boolean> = { scale: false, clamp: false };
function enable(name: Step): void {
  enabled[name] = true;
}
const totals: Record<string, number> = {};
function run(t: Transform): number {
  enable("scale");
  totals["clamp"] = 1;
  return t.clamp(t.scale(3));
}
console.log(run(new Transform()));
`);
  expect(dynamicCalls(mod)).toBe(0);
});

test("element writes through untyped receivers can still replace a method", async () => {
  const mod = await lowerSource(`${shape}
function replace(target: object, name: Step): void {
  (target as any)[name] = (x: number) => x + 100;
}
function run(t: Transform): number {
  replace(t, "scale");
  return t.clamp(t.scale(3));
}
console.log(run(new Transform()));
`);
  expect(dynamicCalls(mod)).toBeGreaterThan(0);
});
