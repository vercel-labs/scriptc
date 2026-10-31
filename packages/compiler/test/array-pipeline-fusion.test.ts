import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrFunction, IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

async function lowerSource(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-array-fusion-"));
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

/** Helper callees named in `fn`, by their `%arr.<method>` prefix. */
function helperCalls(fn: IrFunction): string[] {
  const calls: string[] = [];
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === "call" && e.callee.startsWith("%arr."))
        calls.push(e.callee.replace(/\.[0-9a-f]+$/, ""));
      return true;
    },
    stmt: () => true,
  });
  return calls.sort();
}

/** The authored function `run` every fixture wraps its code in. */
function init(mod: IrModule): IrFunction {
  const fn = mod.functions.find((f) => f.name === "run");
  if (!fn) throw new Error("no run function");
  return fn;
}

function count(fn: IrFunction, kind: string): number {
  let n = 0;
  everyStmtList(fn.body, {
    expr: (e) => {
      if (e.kind === kind) n++;
      return true;
    },
    stmt: () => true,
  });
  return n;
}

const prelude = `
interface Row { id: number; group: string; value: number }
const rows: Row[] = [];
for (let i = 0; i < 10; i++) rows.push({ id: i, group: i % 2 === 0 ? "a" : "b", value: i * 3 });
function run(): void {
`;
const postlude = `
}
run();
`;

test("pure chains become one loop without intermediate arrays", async () => {
  const mod = await lowerSource(`${prelude}
const total = rows
  .filter((r) => r.group === "a")
  .map((r) => ({ id: r.id, score: r.value * 2 }))
  .filter((s) => s.score > 4)
  .reduce((sum, s) => sum + s.score, 0);
const picked = rows.filter((r) => r.value > 6);
const n = picked.length;
console.log(total, n, rows.slice(2, 8).map((r) => r.id).some((id) => id === 5));
${postlude}`);
  expect(helperCalls(init(mod))).toEqual(["%arr.fused", "%arr.fused", "%arr.fused"]);
  expect(init(mod).locals.some((l) => l.name === "picked")).toBe(false);
  // The per-element { id, score } record exists only as scalar locals.
  const fused = mod.functions.filter((f) => f.name.startsWith("%arr.fused."));
  expect(fused).toHaveLength(3);
  for (const fn of fused) {
    expect(count(fn, "recordLit")).toBe(0);
    expect(count(fn, "arrayLit")).toBe(0);
  }
});

test("observable callback order keeps the stage-by-stage helpers", async () => {
  const mod = await lowerSource(`${prelude}
const log: string[] = [];
const a = rows.map((r) => { log.push("m" + r.id); return r.value; }).filter((v) => v > 3);
let seen = 0;
const b = rows.map((r) => { seen++; return r.id; }).filter((id) => id < seen);
let mapped = 0;
const c = rows.map((r) => { mapped++; return r.id; }).filter((id) => { if (id > 5) throw new Error("x"); return true; });
let found = 0;
const d = rows.map((r) => { found++; return r.id; }).some((id) => id === 1);
const e = rows.map((r) => r.id).filter((id, i, all) => all.length > i);
console.log(a.length, b.length, c.length, d, e.length, log.length, seen, mapped, found);
${postlude}`);
  expect(helperCalls(init(mod))).not.toContain("%arr.fused");
});

test("a binding read twice stays an array", async () => {
  const mod = await lowerSource(`${prelude}
const kept = rows.filter((r) => r.value > 3);
console.log(kept.map((r) => r.id).length, kept.length);
${postlude}`);
  expect(init(mod).locals.some((l) => l.name === "kept")).toBe(true);
  expect(helperCalls(init(mod))).toEqual(["%arr.fused", "%arr.loop"]);
});

test("a lone call with a stable closure-literal callback runs as a loop", async () => {
  const mod = await lowerSource(`${prelude}
const scale = 3;
const scaled = rows.map((r) => r.value * scale);
let total = 0;
rows.forEach((r) => { total += r.value; });
const big = rows.filter((r) => r.value > scale);
const sum = scaled.reduce((acc, v) => acc + v, 0);
console.log(scaled.length, total, big.length, sum, rows.some((r) => r.id === scale));
${postlude}`);
  // forEach assigns \`total\`, a binding of \`run\`: it keeps its helper.
  expect(helperCalls(init(mod))).toEqual([
    "%arr.forEach",
    "%arr.loop",
    "%arr.loop",
    "%arr.loop",
    "%arr.loop",
  ]);
  const loops = mod.functions.filter((f) => f.name.startsWith("%arr.loop."));
  expect(loops).toHaveLength(4);
  // The callback bodies are copied into the loops: no closure value is
  // created or called, and the captured \`scale\` is a plain parameter.
  for (const fn of loops) {
    expect(count(fn, "callValue")).toBe(0);
    expect(count(fn, "closure")).toBe(0);
  }
  expect(count(init(mod), "closure")).toBe(1);
  // No closure captures \`scale\` any more, so it needs no box.
  expect(init(mod).locals.find((l) => l.name === "scale")?.boxed).toBeUndefined();
});

test("a lone call keeps its helper when a capture can change while it runs", async () => {
  const mod = await lowerSource(`${prelude}
let limit = 2;
const bump = (): void => { limit++; };
const a = rows.filter((r) => { bump(); return r.id < limit; });
let step = 1;
step = 2;
const b = rows.map((r) => r.id * step);
console.log(a.length, b.length, limit);
${postlude}`);
  expect(helperCalls(init(mod))).toEqual(["%arr.filter", "%arr.map"]);
});

test("a lone call keeps its helper when a local class's method can assign a capture", async () => {
  const mod = await lowerSource(`${prelude}
let k = 1;
class Bump {
  go(): void { k = 10; }
}
const b = new Bump();
const out = rows.map((r) => { if (r.id === 2) b.go(); return r.id * k; });
console.log(out.join(","));
${postlude}`);
  expect(helperCalls(init(mod))).toEqual(["%arr.map"]);
});

test("a copied callback keeps its switch and for-of labels and bindings", async () => {
  const mod = await lowerSource(`${prelude}
const out = rows.map((r) => {
  let n = 0;
  outer: switch (r.id % 3) {
    case 0:
      n = 10;
      break outer;
    case 1:
      inner: for (const v of [1, 2, 3]) {
        n += v;
        if (v === 2) break outer;
        if (v === 3) continue inner;
      }
      break;
    default:
      n = r.value;
  }
  return n;
});
console.log(out.join(","));
${postlude}`);
  expect(helperCalls(init(mod))).toEqual(["%arr.loop"]);
});

test("a copied callback's switch-local records and known unions are rewritten in its cases", async () => {
  const mod = await lowerSource(`${prelude}
type Shape = { kind: "sq"; side: number } | { kind: "rect"; w: number; h: number };
const out = rows.map((r) => {
  switch (r.id % 3) {
    case 0:
      const p = { a: r.id, b: 2 };
      return p.a + p.b;
    case 1:
      const sq = { kind: "sq" as const, side: r.value };
      const s: Shape = sq;
      return s.kind === "sq" ? s.side * 10 : 0;
    default:
      return r.value;
  }
});
console.log(out.join(","));
${postlude}`);
  expect(helperCalls(init(mod))).toEqual(["%arr.loop"]);
});

test("a copied callback with early returns keeps its switch labels", async () => {
  const mod = await lowerSource(`${prelude}
const out = rows.map((r) => {
  let n = 0;
  outer: switch (r.id % 4) {
    case 0:
      return -1;
    case 1:
      n = 10;
      break outer;
    default:
      inner: switch (r.value % 2) {
        case 0:
          n = r.value;
          break outer;
        default:
          break inner;
      }
      n = 1;
  }
  return n;
});
const hit = rows.some((r) => {
  pick: switch (r.id) {
    case 3:
      break pick;
    default:
      return false;
  }
  return true;
});
console.log(out.join(","), hit);
${postlude}`);
  expect(helperCalls(init(mod))).toEqual(["%arr.loop", "%arr.loop"]);
});

test("a lone call in a local class's method keeps its helper for the class's captures", async () => {
  const mod = await lowerSource(`${prelude}
let k = 1;
class Box {
  set(v: number): void { k = v; }
  go(): number[] {
    const b = new Box();
    return rows.map((r) => { b.set(r.id); return r.value + k; });
  }
}
console.log(new Box().go().join(","));
${postlude}`);
  const go = mod.functions.find((f) => f.name.endsWith(".Box.go"));
  expect(go).toBeDefined();
  expect(helperCalls(go!)).toEqual(["%arr.map"]);
});
