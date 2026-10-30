import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { InlineUnionFields, isScalarUnionDef } from "./inline-unions.js";

async function moduleFor(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inline-unions-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The body of a source function: its borrowing or i32 entry when it has one. */
function body(ir: string, name: string): string {
  return new RegExp(`^define internal [^\\n]*@sc_b?f_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    ir,
  )![0];
}

const SAMPLES = `
interface Sample { v: number | undefined; w: number | undefined; label: string }
const kept: Sample[] = [];
export function sum(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    const w = a[i + 1];
    const o = { v, w };
    s += (o.v ?? 0) + (o.w ?? 0);
  }
  return s;
}
export function keep(a: number[], i: number): number {
  const o: Sample = { v: a[i], w: undefined, label: "k" };
  kept.push(o);
  o.w = o.v;
  return kept.length;
}
console.log(sum([1, 2, 3]), keep([4], 0), kept);
`;

test("scalar-union record fields store their tag and bits inline", async () => {
  const mod = await moduleFor(SAMPLES);
  const ir = emitLlvmModule(mod);
  // Both shapes lay out each union field as a { tag, bits } pair.
  expect(ir).toMatch(/%sc_rs_\w+ = type \{ i64, \{ i32, i64 \}, \{ i32, i64 \} \}/);
  expect(ir).toMatch(/%sc_rs_\w+ = type \{ i64, ptr, \{ i32, i64 \}, \{ i32, i64 \} \}/);
  // The projected record and its union locals build no union boxes; the
  // record itself lives in frame storage.
  const sum = body(ir, "sum");
  expect(sum).not.toMatch(/@scr_union_new_/);
  expect(sum).not.toMatch(/@sc_rnew_/);
  expect(sum).not.toMatch(/@scr_union_(retain|release)/);
  // A stored record still allocates, but its fields own nothing.
  const keep = body(ir, "keep");
  expect(keep).toMatch(/call ptr @sc_rnew_/);
  // A published write snapshots its RHS before admission. Only that
  // temporary owns a box; the destination still copies tag/bits inline.
  const boxes = [...keep.matchAll(/(%t\d+) = call ptr @scr_union_new_f64\(/g)];
  expect(boxes).toHaveLength(1);
  expect(boxes[0]!.index).toBeGreaterThan(keep.indexOf("@scr_arr_push_many"));
  const snapshot = new RegExp(
    `(%t\\d+) = phi ptr \\[ ${boxes[0]![1]},[^\\n]+\\n  store ptr \\1, ptr (%sc_l__x25_native_write_\\d+)`,
  ).exec(keep);
  expect(snapshot).not.toBeNull();
  expect(keep.indexOf("@scr_native_object_check_set")).toBeGreaterThan(snapshot!.index);
  const cleanup = new RegExp(
    `(%t\\d+) = load ptr, ptr ${snapshot![2]}\\n  call void @scr_union_release\\(ptr \\1\\)`,
    "g",
  );
  const releases = [...keep.matchAll(cleanup)];
  expect(releases).toHaveLength(2);
  expect(releases[0]!.index).toBeGreaterThan(keep.indexOf("@scr_native_object_finish_write"));
  expect(keep.slice(releases[1]!.index)).toContain("ret double");
  const destroy = /^define internal void @sc_rrelease_r\d+_destroy\([^]*?^}/m.exec(ir)?.[0] ?? "";
  expect(destroy).not.toContain("scr_union_release");
});

const PROBES = `
class Probe {
  x: number | undefined;
  hit: boolean | undefined;
  constructor(x: number | undefined) {
    if (x !== undefined) this.x = x;
  }
}
export function probe(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const p = new Probe(a[i + 1]);
    s += (p.x ?? 0) + (p.hit === undefined ? 1 : 0);
  }
  return s;
}
console.log(probe([1, 2, 3]));
`;

test("class fields store inline and projected instances live in frame storage", async () => {
  const mod = await moduleFor(PROBES);
  const ir = emitLlvmModule(mod);
  expect(ir).toMatch(/%sc_o_Probe = type \{ i64, \{ i32, i64 \}, \{ i32, i64 \} \}/);
  const probe = body(ir, "probe");
  expect(probe).toMatch(/alloca %sc_o_Probe, align 8/);
  expect(probe).not.toMatch(/@sc_new_Probe/);
  // The constructor argument is a stack copy, not a heap box.
  expect(probe).not.toMatch(/@scr_union_new_/);
  // Bare declarations define undefined before conditional constructor writes,
  // so callers no longer need a second zero-initialization pass.
  const ctor = mod.functions.find((fn) => fn.name === "%Probe.constructor")!;
  const conditional = ctor.body.findIndex((stmt) => stmt.kind === "if");
  expect(conditional).toBeGreaterThanOrEqual(0);
  const definitions = ctor.body.filter((stmt) => stmt.kind === "fieldSet");
  expect(definitions.map((stmt) => stmt.field)).toEqual(["x", "hit"]);
  for (const definition of definitions) {
    expect(ctor.body.indexOf(definition)).toBeLessThan(conditional);
    expect(definition.propertyOp).toBe("define");
    const value = definition.value;
    expect(value.kind).toBe("unionWrap");
    if (value.kind !== "unionWrap") throw new Error("missing undefined definition");
    const union = mod.unions!.find((item) => item.id === value.unionId)!;
    expect(union.arms[value.tag]).toEqual({ kind: "undefinedT" });
  }
  expect(probe).not.toContain("store %sc_o_Probe zeroinitializer");
});

test("only unions of numbers, booleans and unit values store inline", () => {
  const unions = new Map([
    ["u0", { id: "u0", arms: [{ kind: "f64" as const }, { kind: "undefinedT" as const }] }],
    ["u1", { id: "u1", arms: [{ kind: "bool" as const }, { kind: "nullT" as const }] }],
    [
      "u2",
      {
        id: "u2",
        arms: [
          { kind: "f64" as const },
          { kind: "bool" as const },
          { kind: "undefinedT" as const },
        ],
      },
    ],
    ["u3", { id: "u3", arms: [{ kind: "string" as const }, { kind: "undefinedT" as const }] }],
  ]);
  const inline = new InlineUnionFields(unions);
  expect(inline.record({ kind: "union", unionId: "u0" })).toBe(true);
  expect(inline.record({ kind: "union", unionId: "u1" })).toBe(true);
  expect(inline.record({ kind: "union", unionId: "u2" })).toBe(true);
  expect(inline.record({ kind: "union", unionId: "u3" })).toBe(false);
  expect(inline.record({ kind: "f64" })).toBe(false);
  expect(isScalarUnionDef(undefined)).toBe(false);
});
