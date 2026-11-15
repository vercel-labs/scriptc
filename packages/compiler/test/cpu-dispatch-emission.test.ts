import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { compile, deserializeModule, type IrModule } from "../src/index.js";
import { emitLlvmModule, type LlvmTargetOptions } from "../src/backend/llvm/emitter.js";

const program = `
function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function scale(a: Float64Array, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}
function positive(x: number): boolean {
  return x > 0;
}
function check(x: number): number {
  if (x < 0) throw new RangeError("negative");
  return Math.sqrt(x);
}
async function later(x: number): Promise<number> {
  await null;
  return dot(new Float64Array([x]), new Float64Array([x]));
}
const a = new Float64Array(64).map((_, i) => i * 0.5);
scale(a, 1.25);
console.log(dot(a, a), [1, -2, 3].filter(positive).length);
try {
  console.log(check(dot(a, a)), check(-1));
} catch (error) {
  console.log((error as Error).message);
}
later(3).then((value) => console.log(value));
`;

let mod: IrModule;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-cpu-dispatch-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, program);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    mod = deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

const x86 = { targetTriple: "x86_64-unknown-linux-gnu", unwindAbi: true } as const;

function emit(options: LlvmTargetOptions): string {
  return emitLlvmModule(mod, options);
}

/** Each definition's text by name. */
function definitions(ll: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of ll.matchAll(/^define [^\n]*?@([\w.$-]+)\([^]*?^}/gm)) out.set(m[1]!, m[0]);
  return out;
}

test("a dispatching x86-64 build copies the program's functions with a loop", () => {
  const ll = emit({ ...x86, cpuDispatch: true });
  const defs = definitions(ll);
  const cloned = [...defs.keys()]
    .filter((name) => name.endsWith(".v3"))
    .map((name) => name.slice(0, -3))
    .sort();
  // dot and scale, and the compiler's loop helpers for the array filter, the
  // fused loop and Float64Array.map, run loops the level widens. positive,
  // check and main have nothing the level compiles better, so they keep the
  // body they had.
  expect(cloned.filter((name) => !name.startsWith("sc_bf__x25_"))).toEqual([
    "sc_bf_dot",
    "sc_bf_scale",
  ]);
  for (const name of ["sc_f_positive", "sc_f_check", "sc_f__x25_main"]) {
    expect(defs.has(name), name).toBe(true);
    expect(defs.has(`${name}.v3`), name).toBe(false);
    expect(defs.has(`${name}.base`), name).toBe(false);
  }
  const dispatched = cloned.filter((name) => defs.has(name));
  for (const name of cloned) {
    const v3 = defs.get(`${name}.v3`)!;
    expect(defs.get(`${name}.base`), name).toBeDefined();
    expect(v3.split("\n", 1)[0]).toMatch(/ #[34]( |$)/);
    // The function's own name, where the module still uses it, dispatches
    // on the level.
    const dispatcher = defs.get(name);
    if (dispatcher === undefined) {
      expect(ll, name).not.toMatch(new RegExp(`@${name.replace(/[.$]/g, "\\$&")}(?![\\w.$-])`));
      continue;
    }
    expect(dispatcher).toContain("load i32, ptr @sc_cpu_level");
    expect(dispatcher).toContain(`musttail call`);
    expect(dispatcher).toContain(`@${name}.v3(`);
    expect(dispatcher).toContain(`@${name}.base(`);
    // A copy calls the other cloned functions' copies of its own tier.
    for (const call of v3.matchAll(/@([\w.$-]+)\(/g)) {
      const callee = call[1]!;
      expect(cloned.includes(callee), `${name}.v3 calls ${callee}`).toBe(false);
      if (callee.endsWith(".base")) throw new Error(`${name}.v3 calls ${callee}`);
    }
    for (const call of defs.get(`${name}.base`)!.matchAll(/@([\w.$-]+)\(/g))
      expect(call[1]!.endsWith(".v3"), `${name}.base calls ${call[1]}`).toBe(false);
  }
  // main and the coroutine body, which the build does not copy, call the
  // copies, so they keep a dispatcher.
  expect(dispatched).toContain("sc_bf_dot");
  expect(dispatched).toContain("sc_bf_scale");
  // Coroutine bodies keep one body.
  const coroutines = [...defs].filter(([, text]) => / #1 /.test(text.split("\n", 1)[0]!));
  expect(coroutines.length).toBeGreaterThan(0);
  for (const [name] of coroutines) expect(defs.has(`${name}.v3`), name).toBe(false);
  // Functions used as values are referenced by their dispatching name.
  expect(ll).not.toMatch(/ptr @[\w.$-]+\.(v3|base)(?!\()/);
  expect(ll).toMatch(
    /^attributes #3 = \{ sanitize_address uwtable "target-cpu"="x86-64-v3" "scriptc-cpu-copy" \}$/m,
  );
  // Unsanitized builds leave sanitize_address out of the copies' groups too.
  expect(emit({ ...x86, cpuDispatch: true, sanitizeAttributes: false })).toMatch(
    /^attributes #3 = \{ uwtable "target-cpu"="x86-64-v3" "scriptc-cpu-copy" \}$/m,
  );
  // main sets the level before anything else runs.
  expect(defs.get("main")).toMatch(
    /^entry:\n(?: {2}call void @scr_runtime_abi\w*\(\)\n)?  call void @sc_cpu_level_init\(\)$/m,
  );
  // No copy contracts floating-point operations.
  expect(ll).not.toMatch(
    /\b(?:fadd|fsub|fmul|fdiv|frem|call) (?:[a-z]+ )*(?:contract|fast|afn|reassoc)\b/,
  );
});

/** The program functions the build copied, by their original names. */
function clonedNames(ll: string): string[] {
  return [...definitions(ll).keys()]
    .filter((name) => name.endsWith(".v3"))
    .map((name) => name.slice(0, -3))
    .sort();
}

test("a build that uses a profile copies only the functions it names", () => {
  const ll = emit({
    ...x86,
    cpuDispatch: true,
    cpuCopyFunctions: new Set(["sc_bf_dot", "sc_f_positive"]),
  });
  // positive is named by the profile but has no loop, so the build keeps its
  // one body.
  expect(clonedNames(ll)).toEqual(["sc_bf_dot"]);
  expect(definitions(ll).has("sc_f_positive")).toBe(true);
  expect(ll).not.toMatch(/@sc_f_positive\.(?:base|v3)/);
});

test("a build whose profile names no function copies none", () => {
  expect(clonedNames(emit({ ...x86, cpuDispatch: true, cpuCopyFunctions: new Set() }))).toEqual([]);
});

test("the copies stop at the text budget", () => {
  expect(clonedNames(emit({ ...x86, cpuDispatch: true, cpuCopyCapBytes: 1 }))).toEqual([]);
  expect(
    clonedNames(emit({ ...x86, cpuDispatch: true, cpuCopyCapBytes: 8 * 1024 * 1024 })),
  ).toEqual(clonedNames(emit({ ...x86, cpuDispatch: true })));
  // The budget takes the largest bodies first: 30 KB holds the byte map
  // (16874 bytes) and the fused loop (7864), drops the filter (7623), still
  // holds dot (5066), and has no room for scale (1748).
  const capped = clonedNames(emit({ ...x86, cpuDispatch: true, cpuCopyCapBytes: 30_000 }));
  expect(capped).toContain("sc_bf_dot");
  expect(capped).not.toContain("sc_bf_scale");
  expect(capped).toHaveLength(3);
});

test("a build that records a profile keeps the functions a copy needs out of line", () => {
  const ll = emit({ ...x86, cpuDispatch: true, profileGenerate: true });
  // The profile names the functions the build that uses it copies, so the
  // recording build does not copy them itself.
  expect(ll).not.toMatch(/\.(?:base|v3)\(/);
  const defs = definitions(ll);
  for (const name of ["sc_bf_dot", "sc_bf_scale"])
    expect(defs.get(name)?.split("\n", 1)[0], name).toMatch(/\bnoinline\b/);
  // A function without a loop keeps the emission it had.
  for (const name of ["sc_f_positive", "sc_f__x25_main"])
    expect(defs.get(name)?.split("\n", 1)[0], name).not.toMatch(/\bnoinline\b/);
});

test("builds without dispatch, for other targets or for other target levels emit no copies", () => {
  const plain = emit(x86);
  expect(plain).not.toContain("@sc_cpu_level");
  expect(plain).not.toMatch(/\.v3\(/);
  expect(emit({ ...x86, cpuDispatch: false })).toBe(plain);
  for (const targetCpu of ["x86-64-v2", "x86-64-v4"] as const) {
    const level = emit({ ...x86, targetCpu });
    expect(level, targetCpu).not.toMatch(/\.(?:v3|base)\(/);
    expect(emit({ ...x86, targetCpu, cpuDispatch: true }), targetCpu).toBe(level);
  }
  for (const options of [
    { targetTriple: "aarch64-unknown-linux-gnu" },
    { targetTriple: "wasm32-wasi", wasi: true, pointerBits: 32 as const },
  ])
    expect(emit({ ...options, cpuDispatch: true })).toBe(emit(options));
});

test("an x86-64-v3 target gives the program's functions baseline copies, and always calls the x86-64-v3 ones", () => {
  const ll = emit({ ...x86, targetCpu: "x86-64-v3" });
  expect(emit({ ...x86, targetCpu: "x86-64-v3", cpuDispatch: true })).toBe(ll);
  expect(ll).toMatch(/^define internal double @sc_bf_dot\.base\([^\n]* #5 /m);
  expect(ll).toMatch(/^define internal double @sc_bf_dot\.v3\([^\n]* #3 /m);
  expect(ll).toMatch(/^attributes #0 = \{ sanitize_address uwtable "target-cpu"="x86-64-v3" \}$/m);
  expect(ll).toMatch(
    /^attributes #3 = \{ sanitize_address uwtable "target-cpu"="x86-64-v3" "scriptc-cpu-copy" \}$/m,
  );
  expect(ll).toMatch(/^attributes #5 = \{ sanitize_address uwtable \}$/m);
  // The level is 3 from the start; nothing detects or stores it.
  expect(ll).toMatch(/^@sc_cpu_level = hidden global i32 3$/m);
  expect(ll).not.toContain("@sc_cpu_level_init");
  expect(ll).not.toMatch(/store i32 [^\n]*, ptr @sc_cpu_level\b/);
});
