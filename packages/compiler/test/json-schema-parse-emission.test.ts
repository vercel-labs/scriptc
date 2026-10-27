import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("JSON.parse casts to plain records and arrays fuse into the schema parser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-json-schema-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
interface Item { sku: string; qty: number; ok: boolean }
interface Order { id: number; items: Item[]; tags: string[] }
interface Loose { name: string; note?: string }
interface Meta { source: string }
interface Mixed { id: number; meta: Meta | null; score: number | null; key: string | number }
interface Shape { kind: string; a: number }
interface Other { kind: string; b: string }
interface Either { s: Shape | Other }
interface Pkg { name: string; deps: Record<string, string>; counts: { [k: string]: number } }
const text = process.argv[2] ?? "[]";
const orders = JSON.parse(text) as Order[];
const typed: Item = JSON.parse(text);
const loose = JSON.parse(text) as Loose;
const mixed = JSON.parse(text) as Mixed[];
const pair = JSON.parse(text) as [string, number];
const either = JSON.parse(text) as Either;
const holes = JSON.parse(text) as (string | null)[];
const pkg = JSON.parse(text) as Pkg;
console.log(orders.length, typed.sku, loose.name, mixed.length, pair[0], either.s.kind, holes.length, pkg.name);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));

    const llvm = emitLlvmModule(mod);
    // Order[], Item (an annotated binding), the optional and nullable
    // members of Loose and Mixed[], and Pkg's index signatures take the
    // fused path; the record schema lists fields in declaration order with
    // struct offsets.
    expect(llvm.match(/^define internal ptr @sc_jp_\d+(?:\.i32)?\(ptr %text\)/gm)).toHaveLength(5);
    expect(llvm).toContain("call ptr @scr_json_parse_schema(ptr %text, ptr @sc_jsch_");
    expect(llvm).toMatch(
      /@sc_jsch_\d+_fields = internal constant \[3 x \{ ptr, i64, i64, ptr \}\] \[\{ ptr, i64, i64, ptr \} \{ ptr @sc_cs_\d+, i64 3, i64 ptrtoint/,
    );
    // Declining reruns the exact checked-dynamic route.
    expect(llvm).toMatch(
      /%d = call ptr @scr_json_parse\(ptr %text\)\n {2}%bad = icmp eq ptr %d, null/,
    );
    expect(llvm).toMatch(/%v = call ptr @sc_dc_\d+\(ptr %d, ptr null\)/);
    // Union members describe their slot representation: the nullable
    // record pointer (0), the inline scalar pair (1), and a tagged box built
    // through the schema's box function (2), with arm tags by JSON kind.
    expect(llvm).toMatch(
      /@sc_jsch_\d+_union = internal constant \{ i64, \[7 x i64\], \[7 x ptr\], ptr, ptr, ptr, ptr \} \{ i64 0, /,
    );
    expect(llvm).toMatch(
      /@sc_jsch_\d+_union = internal constant \{ i64, \[7 x i64\], \[7 x ptr\], ptr, ptr, ptr, ptr \} \{ i64 1, /,
    );
    expect(llvm).toMatch(
      /@sc_jsch_\d+_union = internal constant \{ i64, \[7 x i64\], \[7 x ptr\], ptr, ptr, ptr, ptr \} \{ i64 2, .*ptr @sc_jsch_\d+_box, ptr null \}/,
    );
    expect(llvm).toMatch(/^define internal ptr @sc_jsch_\d+_box\(i32 %tag, i64 %bits\)/m);
    // A pure dictionary has no declared fields: its index value schema and
    // overflow map offset describe every member.
    expect(llvm).toMatch(
      /= internal constant \{ i64, i64, ptr, ptr, ptr, ptr, ptr, ptr, i64 \} \{ i64 3, i64 0, ptr null, ptr @sc_jsch_\d+, ptr @\S+, ptr null, ptr @\S+, ptr null, i64 ptrtoint/,
    );
    // Tuples, two record arms, and unions outside a record member keep the
    // checked-dynamic route alone.
    expect(llvm.match(/call ptr @scr_json_parse\(ptr /g)!.length).toBeGreaterThanOrEqual(7);

    const wasm = emitLlvmModule(mod, { pointerBits: 32, wasi: true });
    expect(wasm).toContain("= internal constant { i32, i32, ptr, ptr, ptr, ptr, ptr, ptr, i32 }");
    expect(wasm).toContain("= internal constant { i32, [7 x i32], [7 x ptr], ptr, ptr, ptr, ptr }");
    expect(wasm).toMatch(/\{ ptr, i32, i32, ptr \} \{ ptr @sc_cs_\d+, i32 3, i32 ptrtoint/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSON.parse casts to discriminated unions fuse into the schema parser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-json-schema-union-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
type Event =
  | { kind: "click"; x: number; y: number }
  | { kind: "focus" | "blur"; target: string }
  | { kind: "load"; ms: number; next: Event | null };
type Expr = { kind: "num"; value: number } | { kind: "add"; items: Expr[] };
type Loose = { kind: string; a: number } | { kind: string; b: string };
const text = process.argv[2] ?? "[]";
const events = JSON.parse(text) as Event[];
const tree = JSON.parse(text) as Expr;
const loose = JSON.parse(text) as Loose[];
console.log(events.length, tree.kind, loose.length);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const llvm = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    // Event[] and the whole-document Expr take the fused path; a union
    // without literal discriminants keeps the checked-dynamic route alone.
    expect(llvm.match(/^define internal ptr @sc_jp_\d+(?:\.i32)?\(ptr %text\)/gm)).toHaveLength(2);
    expect(llvm.match(/call ptr @scr_json_parse\(ptr /g)).toHaveLength(3);
    // Each literal names its arm's tag and record schema; an arm with two
    // literals is listed under both. Event, `Event | null` and Expr each
    // have a table.
    const cases = [...llvm.matchAll(/^@sc_jsch_\d+_case_table = internal constant \[(\d+) x /gm)];
    expect(cases.map((m) => Number(m[1])).sort()).toEqual([2, 4, 4]);
    expect(llvm).toMatch(
      /^@sc_jsch_\d+_cases = internal constant \{ ptr, i64, i64, ptr \} \{ ptr @sc_cs_\d+, i64 4, i64 4, ptr @sc_jsch_\d+_case_table \}/m,
    );
    // The union descriptors point at their cases, and a union schema that
    // can be a whole document carries its release.
    expect(llvm).toMatch(
      /@sc_jsch_\d+_union = internal constant \{ i64, \[7 x i64\], \[7 x ptr\], ptr, ptr, ptr, ptr \} \{ .*, ptr @sc_jsch_\d+_cases \}/,
    );
    expect(llvm).toMatch(
      /= internal constant \{ i64, i64, ptr, ptr, ptr, ptr, ptr, ptr, i64 \} \{ i64 5, i64 0, ptr null, ptr null, ptr null, ptr null, ptr @\S+, ptr @sc_jsch_\d+_union, i64 0 \}/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
