import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitSource(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-live-view-commit-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function emit(body: string, fallback = '"nonobject"'): Promise<string> {
  return emitSource(`
class Node {
  kind: number;
  next: Node | undefined;
  data: { label: string; size: number };
  constructor(kind: number) {
    this.kind = kind;
    this.next = undefined;
    this.data = { label: "n" + kind, size: kind };
  }
}
function debug(x: unknown): string {
  if (typeof x !== "object" || x === null) return ${fallback};
  ${body}
}
const n = new Node(process.argv.length);
n.next = new Node(2);
console.log(debug(n));
`);
}

test("class and record views commit nothing when no dynamic store exists", async () => {
  const llvm = await emitSource(`
class Node {
  kind = process.argv.length;
  next: Node | undefined = undefined;
  data = { label: "node", size: 1 };
}
function debug(x: unknown): string {
  if (typeof x !== "object" || x === null) return "nonobject";
  return Object.keys(x).join(",") + JSON.stringify(Object.values(x));
}
console.log(debug(new Node()));
`);
  expect(llvm).toMatch(/define internal ptr @sc_ldr_\d+_materialize\(/);
  expect(llvm).not.toMatch(/define internal void @sc_ldr_\d+_materialize_commit\(/);
});

test("guarded typed Sets retain commits for possible setter callbacks", async () => {
  const llvm = await emit(`return Object.keys(x).join(",") + JSON.stringify(Object.values(x));`);
  expect(llvm).toContain("@scr_native_object_check_set");
  expect(llvm).toMatch(/define internal void @sc_ldr_\d+_materialize_commit\(/);
});

test("a dynamic store keeps the commits of class and record views", async () => {
  const llvm = await emit(`(x as Record<string, unknown>)["kind"] = 1.5;
  return Object.keys(x).join(",");`);
  expect(llvm).toMatch(/define internal void @sc_ldr_\d+_materialize_commit\(/);
});

test("array commits and cached casts share indexed storage without moving named properties", async () => {
  const llvm = await emitSource(`
function refresh(value: unknown): number[] {
  return value as number[];
}
function reverse(value: unknown): void {
  (value as unknown[]).reverse();
}
const values: number[] = [process.argv.length, 2];
reverse(values);
console.log(refresh(values)[0]);
`);
  const functions = llvm.match(/^define internal (?:ptr|void) @[^\n]+\n[\s\S]*?^}/gm) ?? [];
  const swaps = functions.filter((fn) => fn.includes("call void @scr_arr_swap_indexed_storage("));
  const commit = swaps.find((fn) => fn.includes("_materialize_commit("));
  const refresh = swaps.find((fn) => fn.startsWith("define internal ptr @sc_dc_"));
  expect(commit).toBeDefined();
  expect(refresh).toBeDefined();
  for (const fn of [commit!, refresh!]) {
    expect(fn.match(/call void @scr_arr_swap_indexed_storage\(/g)).toHaveLength(1);
    expect(fn).not.toMatch(
      /getelementptr inbounds %ScrArr|@scr_arr_outline|@scr_arr_swap_indexed_ext/,
    );
    expect(fn).toMatch(
      /call void @scr_arr_swap_indexed_storage\(ptr (%\w+), ptr (%\w+)\)\n\s+call void @(?:scr_arr_release|sc_rc_release_arr)\(ptr \2\)/,
    );
  }
  expect(commit).toMatch(/br i1 %missing, label %done, label %swap/);
  expect(refresh).toMatch(/br i1 %\w+, label %dc\.tr\.ok\d+, label %dc\.tr\.bad\d+/);
});

test("method-only tuple mutations retain their live view commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-tuple-view-commit-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(
      entry,
      `
function reverse(value: unknown): void {
  const view = value as unknown[];
  view.reverse();
}
const pair: [number, number] = [1, 2];
reverse(pair);
console.log(pair[0], pair[1]);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const llvm = await readFile(outPath, "utf8");
    expect(llvm).toMatch(
      /call ptr @scr_dyn_new_typed_ref\w*\([^\n]*ptr @(sc_ldr_\d+_materialize), ptr @\1_commit\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("String of unknown retains class and record view commits", async () => {
  const llvm = await emit('return "";', "String(x)");
  expect(llvm).toMatch(/define internal void @sc_ldr_\d+_materialize_commit\(/);
});
