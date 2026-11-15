import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { type IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-json-class-fallbacks-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: output,
      outputKind: "ir",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The module's writer for `t`, found by its emitted comment. */
function writer(llvm: string, kind: string): string {
  const header = new RegExp(`^define [^\\n]*; stringify ${kind}`, "m").exec(llvm);
  expect(header, kind).not.toBeNull();
  const end = llvm.indexOf("\n}", header!.index);
  expect(end, kind).toBeGreaterThan(header!.index);
  return llvm.slice(header!.index, end);
}

function calls(text: string, symbol: string): number {
  return text.match(new RegExp(`@${symbol}\\(`, "g"))?.length ?? 0;
}

// A class instance that took a dynamic property holds it in the compiler-owned
// property bag, past the static layout. The class no longer reads the layout at
// emit time (classJsonReadsLayout), so every position that writes the instance
// must use the runtime walk: a member through scr_jb_put_dyn_member (which runs
// the instance's toJSON with the field's key and drops an omitted member), an
// array slot through scr_jb_put_dyn_element, and the root through
// scr_jb_put_dyn_root. The bag is added while lowering the untyped write, after
// the frontend admitted the class for the layout writer.
const baggedFields = `
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}
class Holder {
  child: Point;
  list: Point[];
  constructor(child: Point, list: Point[]) { this.child = child; this.list = list; }
}
function render(holder: Holder): string { return JSON.stringify(holder); }
function renderRoot(point: Point): string { return JSON.stringify(point); }
const point = new Point(1, 2);
const untyped: any = point;
untyped.extra = 3;
console.log(render(new Holder(point, [point])), renderRoot(point));
`;

test("a member whose class gained a property bag is written by the runtime member walk", async () => {
  const llvm = emitLlvmModule(await lower(baggedFields));
  const holder = writer(llvm, "object:Holder");
  // Both class-typed fields take the runtime member walk, which owns the
  // comma and key (an omitted member leaves the output untouched).
  expect(calls(holder, "scr_jb_put_dyn_member")).toBe(2);
  expect(holder).not.toContain("scr_jb_put_dyn_root");
});

test("the root of a class that gained a property bag runs the root hook step", async () => {
  const llvm = emitLlvmModule(await lower(baggedFields));
  const point = writer(llvm, "object:Point");
  // The writer's only body is the runtime walk from the live capsule, with
  // SerializeJSONProperty's root toJSON step (scr_jb_put_dyn_root).
  expect(calls(point, "scr_jb_put_dyn_root")).toBe(1);
  expect(point).not.toContain("stringify field");
});

// JSON.stringify bounds nesting at 1000 levels in the runtime walk
// (SCR_JSON_MAX_DEPTH). The emitted writers must raise the same catchable
// RangeError: a chain of distinct instances is data-dependent in length, the
// collector analysis need not call it a cycle, and unbounded native recursion
// ends the process instead of throwing.
const recursive = `
class Node2 {
  label: number;
  next: Node2 | undefined;
  constructor(label: number, next: Node2 | undefined) { this.label = label; this.next = next; }
}
function render(node: Node2): string { return JSON.stringify(node); }
console.log(render(new Node2(1, new Node2(2, undefined))));
`;

test("every container writer takes a nesting depth and checks the runtime limit", async () => {
  const llvm = emitLlvmModule(await lower(recursive));
  const node = writer(llvm, "object:Node2");
  expect(node).toMatch(/^define [^\n]*, i64 %d\)/);
  expect(node).toContain("@scr_stack_overflow(");
  expect(node).toContain("icmp ugt i64 %d, 1000");
  // The recursive field is written one level deeper.
  const union = writer(llvm, "union:");
  expect(union).toMatch(/^define [^\n]*, i64 %d\)/);
  expect(union).toContain("@sc_jw_");
  // Leaves cannot recurse and keep their two-parameter shape.
  const number = writer(llvm, "f64");
  expect(number).not.toContain("%d");
});

// A function-valued own `toJSON` field is the JSON hook, so the class must
// never reach the layout writer: the frontend keeps it on the runtime walk.
const hookField = `
class HookField {
  secret = 7;
  toJSON = () => ({ redacted: true });
}
console.log(JSON.stringify(new HookField()));
`;

test("a function-valued toJSON field keeps the class on the runtime walk", async () => {
  const llvm = emitLlvmModule(await lower(hookField));
  expect(llvm).not.toContain("stringify object:HookField");
  expect(llvm).toContain("@scr_json_stringify_replacer(");
});

// An accessor-backed hook (`get toJSON()`) is the hook too; the class
// collects it as method `get:toJSON`.
const accessorHook = `
class AccessorHook {
  secret = 7;
  get toJSON(): { redacted: boolean } { return { redacted: true }; }
}
console.log(JSON.stringify(new AccessorHook()));
`;

test("an accessor-backed toJSON keeps the class on the runtime walk", async () => {
  const llvm = emitLlvmModule(await lower(accessorHook));
  expect(llvm).not.toContain("stringify object:AccessorHook");
  expect(llvm).toContain("@scr_json_stringify_replacer(");
});
