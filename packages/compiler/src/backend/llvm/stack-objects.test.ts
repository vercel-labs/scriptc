import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import {
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { addRecordResultEntries, RESULT_ENTRY_PREFIX } from "./record-results.js";

async function moduleFor(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-stack-objects-"));
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

const VECTORS = `
interface Vec { x: number; y: number }
function add(a: Vec, b: Vec): Vec { return { x: a.x + b.x, y: a.y + b.y }; }
function dot(a: Vec, b: Vec): number { return a.x * b.x + a.y * b.y; }
function shortest(a: Vec): Vec { return a.x < a.y ? { x: a.x, y: 0 } : { x: 0, y: a.y }; }
const kept: Vec[] = [];
export function projected(n: number): number {
  const p = { x: n, y: 1 };
  const q = add(p, { x: 2, y: n });
  return dot(q, p) + dot(shortest(q), q);
}
export function escaping(n: number): number {
  const p = { x: n, y: 1 };
  kept.push(p);
  const q = add(p, p);
  kept.push(q);
  return q.x;
}
export function reassigned(n: number): number {
  let p = { x: n, y: 0 };
  for (let i = 0; i < n; i++) p = add(p, { x: 1, y: i });
  return p.x + p.y;
}
console.log(projected(2), escaping(3), reassigned(4), kept.length);
`;

test("projection-only records live in frame storage and producers fill it", async () => {
  const ir = emitLlvmModule(await moduleFor(VECTORS));
  const projected = body(ir, "projected");
  expect(projected).toMatch(/alloca %sc_rs_\w+, align 8/);
  expect(projected).toContain("store i64 -1, ptr");
  expect(projected).not.toMatch(/@sc_rnew_/);
  expect(projected).toMatch(/call void @sc_\w*into_add\(/);
  expect(projected).toMatch(/call void @sc_\w*into_shortest\(/);
  // The result-slot entries are small and called per use: hinted inline.
  expect(ir).toMatch(/^define internal void @sc_\w*into_add\([^)]*\) inlinehint /m);
  expect(ir).toMatch(/^define internal void @sc_\w*into_shortest\([^)]*\) inlinehint /m);
  // A literal stores every field: its storage is not zeroed first.
  expect(projected).not.toContain("zeroinitializer");
  // Stored values keep the heap path and the ordinary producer.
  const escaping = body(ir, "escaping");
  expect(escaping).toMatch(/call ptr @sc_rnew_/);
  expect(escaping).toMatch(/call ptr @sc_\w*f_add\(/);
  expect(escaping).not.toMatch(/alloca %sc_rs_/);
});

test("reassigned bindings build each value apart and copy it into their slot", async () => {
  const ir = emitLlvmModule(await moduleFor(VECTORS));
  const reassigned = body(ir, "reassigned");
  expect(reassigned).not.toMatch(/@sc_rnew_/);
  expect(reassigned).toMatch(/load %sc_rs_\w+, ptr %s\d+\n\s+store %sc_rs_\w+ %t\d+, ptr %s\d+/);
});

test("result-slot entries cover producers whose every return is fresh or a parameter", async () => {
  const mod = await moduleFor(`
interface Vec { x: number; y: number }
function fresh(n: number): Vec { if (n > 1) return { x: n, y: n }; return { x: 0, y: 1 }; }
function passthrough(v: Vec): Vec { return v; }
function guarded(n: number): Vec { try { return { x: n, y: 0 }; } finally { console.log(n); } }
console.log(fresh(1).x, passthrough({ x: 1, y: 2 }).y, guarded(3).x);
`);
  const entries = addRecordResultEntries(mod)
    .functions.map((fn) => fn.name)
    .filter((name) => name.startsWith(RESULT_ENTRY_PREFIX));
  // A returned parameter of a shape nothing writes is copied; a return
  // inside \`try\` keeps the ordinary function.
  expect(entries).toEqual([`${RESULT_ENTRY_PREFIX}fresh`, `${RESULT_ENTRY_PREFIX}passthrough`]);
});

test("objects stay on the heap when their constructor or a method lets them escape", async () => {
  const ir = emitLlvmModule(
    await moduleFor(`
const seen: Tracked[] = [];
class Tracked { id: number; constructor(id: number) { this.id = id; seen.push(this); } }
class Plain {
  a: number; b: number;
  constructor(a: number, b: number) { this.a = a; this.b = b; }
  sum(): number { return this.a + this.b; }
  self(): Plain { return this; }
}
const selves: Plain[] = [];
export function run(n: number): number {
  const t = new Tracked(n);
  const p = new Plain(n, 1);
  const s = new Plain(n, 2);
  selves.push(s.self());
  return t.id + p.sum() + s.sum();
}
console.log(run(1), seen.length, selves.length);
`),
  );
  const run = body(ir, "run");
  expect(run.match(/alloca %sc_o_\w+, align 8/g)).toHaveLength(1);
  expect(run).toContain("call ptr @sc_new_Tracked()");
  expect(run).toContain("call ptr @sc_new_Plain()");
});

test("loop bindings are never reassigned into a fixed slot", () => {
  const loc = { file: "loop.ts", start: 0, end: 0 };
  const point: IrType = { kind: "record", shapeId: "point" };
  const points: IrType = { kind: "array", elem: point };
  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const x = (obj: IrExpr): IrExpr => ({
    kind: "recordGet",
    obj,
    shapeId: "point",
    field: "x",
    type: F64,
    loc,
  });
  const work: IrFunction = {
    name: "work",
    loc,
    returnType: F64,
    params: [{ localId: "items", name: "items", type: points }],
    locals: [
      { id: "items", name: "items", type: points, mutable: true },
      { id: "total", name: "total", type: F64, mutable: true },
      { id: "p", name: "p", type: point, mutable: true },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "total",
        init: { kind: "numLit", value: 0, type: F64, loc },
        loc,
      },
      {
        kind: "forOf",
        localId: "p",
        iterable: ref("items", points),
        body: [
          {
            kind: "assign",
            localId: "p",
            value: {
              kind: "recordLit",
              fields: [
                {
                  name: "x",
                  value: {
                    kind: "bin",
                    op: "+",
                    left: x(ref("p", point)),
                    right: { kind: "numLit", value: 10, type: F64, loc },
                    type: F64,
                    loc,
                  },
                },
              ],
              type: point,
              loc,
            },
            loc,
          },
          {
            kind: "assign",
            localId: "total",
            value: {
              kind: "bin",
              op: "+",
              left: ref("total", F64),
              right: x(ref("p", point)),
              type: F64,
              loc,
            },
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: ref("total", F64), loc },
    ],
  };
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [{ id: "point", fields: [{ name: "x", type: F64 }] }],
    functions: [{ name: "main", params: [], locals: [], body: [], returnType: VOID, loc }, work],
  };
  expect(validateModule(mod)).toEqual([]);
  const ir = body(emitLlvmModule(mod), "work");
  // The literal keeps its ordinary record; the binding is the element.
  expect(ir).toContain("call ptr @sc_rnew_point()");
  expect(ir).not.toMatch(/alloca %sc_rs_point/);
});

test("objects updated through their methods and parameters stay in frame storage", async () => {
  const ir = emitLlvmModule(
    await moduleFor(`
class Stats {
  n = 0; sum = 0;
  add(v: number): void { this.n++; this.sum += v; }
  mean(): number { return this.sum / this.n; }
}
interface Cursor { pos: number }
function advance(c: Cursor): void { c.pos += 2; }
class Box { v: number; constructor(v: number) { this.v = v; } }
export function run(k: number): number {
  const s = new Stats();
  for (let i = 0; i < k; i++) s.add(i);
  const c: Cursor = { pos: k };
  advance(c);
  let b = new Box(1);
  const old = b;
  b = new Box(2);
  return s.mean() + c.pos + old.v + b.v;
}
console.log(run(3));
`),
  );
  const run = body(ir, "run");
  expect(run).toMatch(/alloca %sc_o_Stats, align 8/);
  expect(run).toMatch(/alloca %sc_rs_\w+, align 8/);
  // An alias of a reassigned binding must keep seeing the old object.
  expect(run).toContain("call ptr @sc_new_Box()");
});

test("producers returning a parameter copy it only for shapes nothing writes", async () => {
  const mod = await moduleFor(`
interface Vec { x: number; y: number }
interface Cell { value: number }
function pick(a: Vec, b: Vec, first: boolean): Vec { return first ? a : b; }
function forward(v: Vec): Vec { return pick(v, { x: 0, y: 0 }, v.x > 0); }
function same(c: Cell): Cell { return c; }
const c: Cell = { value: 1 };
same(c).value += 1;
console.log(pick({ x: 1, y: 2 }, { x: 3, y: 4 }, true).y, forward({ x: 1, y: 1 }).x, c.value);
`);
  const entries = addRecordResultEntries(mod)
    .functions.map((fn) => fn.name)
    .filter((name) => name.startsWith(RESULT_ENTRY_PREFIX))
    .sort();
  expect(entries).toEqual([`${RESULT_ENTRY_PREFIX}forward`, `${RESULT_ENTRY_PREFIX}pick`]);
});

const TOKENS = `
interface Token { kind: string; text: string; pos: number }
function make(kind: string, text: string, pos: number): Token { return { kind, text, pos }; }
function width(t: Token): number { return t.text.length + t.kind.length; }
function divmod(a: number, b: number): [number, number] { return [Math.floor(a / b), a % b]; }
interface State { name: string; count: number }
function bump(s: State): State { return { ...s, count: s.count + 1 }; }
export function tokens(n: number, w: string): number {
  const t = { kind: "id", text: w, pos: n };
  const u = make("num", w, n);
  // Read by index: a destructured literal result is inlined instead.
  const qr = divmod(n, 7);
  return t.pos + width(u) + width({ kind: w, text: w, pos: 0 }) + qr[0] + qr[1];
}
export function states(n: number, w: string): number {
  let s: State = { name: w, count: 0 };
  for (let i = 0; i < n; i++) {
    s = { ...s, count: s.count + 1 };
    s = bump(s);
  }
  return s.count + s.name.length;
}
console.log(tokens(3, "ab"), states(4, "cd"));
`;

test("records and tuples that own references live in frame storage", async () => {
  const ir = emitLlvmModule(await moduleFor(TOKENS));
  const tokens = body(ir, "tokens");
  expect(tokens).not.toMatch(/@sc_rnew_/);
  expect(tokens).toMatch(/call void @sc_\w*into_make\(/);
  expect(tokens).toMatch(/call void @sc_\w*into_divmod\(/);
  // Reference fields start empty in entry-addressed slots, and the frame
  // releases them; an interned literal field (`kind: "id"`) needs neither.
  const fields = [...tokens.matchAll(/(%s\d+) = getelementptr inbounds %sc_rs_\w+, ptr %s\d+/g)];
  const owned = fields.filter(([, ptr]) => tokens.includes(`store ptr null, ptr ${ptr}\n`));
  expect(owned.length).toBe(5);
  expect(fields.length).toBe(6);
  for (const [, ptr] of owned)
    expect(tokens).toMatch(new RegExp(`load ptr, ptr ${ptr}\\n\\s+call void @\\w+\\(`));
});

test("spread updates copy into the binding's slot and release the replaced fields", async () => {
  const mod = await moduleFor(TOKENS);
  const entries = addRecordResultEntries(mod)
    .functions.map((fn) => fn.name)
    .filter((name) => name.startsWith(RESULT_ENTRY_PREFIX));
  expect(entries).toEqual(
    expect.arrayContaining([
      `${RESULT_ENTRY_PREFIX}make`,
      `${RESULT_ENTRY_PREFIX}divmod`,
      `${RESULT_ENTRY_PREFIX}bump`,
    ]),
  );
  const states = body(emitLlvmModule(mod), "states");
  expect(states).not.toMatch(/@sc_rnew_|@sc_rclone_/);
  expect(states).toMatch(/call void @sc_\w*into_bump\(/);
  // The old name is loaded before the copy and released after it.
  expect(states).toMatch(
    /(%t\d+) = load ptr, ptr %s\d+\n\s+(%t\d+) = load %sc_rs_\w+, ptr %s\d+\n\s+store %sc_rs_\w+ \2, ptr %s\d+\n(?:.*\n)*?\s+call void @\w+\(ptr \1\)/,
  );
});

const COLLECTORS = `
class Tag { readonly name: string; constructor(name: string) { this.name = name; } }
class Collector {
  readonly items: string[] = [];
  last: string | undefined = undefined;
  tag: Tag | null = null;
  count = 0;
  add(item: string): void { this.items.push(item); this.last = item; this.count++; }
  label(name: string): void { this.tag = new Tag(name); }
}
function fill(c: Collector, n: number): void { for (let i = 0; i < n; i++) c.add("w" + i); }
const kept: Collector[] = [];
let outer: Collector | null = null;
export function local(n: number): number {
  const c = new Collector();
  fill(c, n);
  c.label("x");
  return c.count + c.items.length + (c.tag?.name.length ?? 0);
}
export function stored(n: number): number {
  const c = new Collector();
  fill(c, n);
  kept.push(c);
  return c.count;
}
export function assigned(n: number): number {
  const c = new Collector();
  outer = c;
  fill(c, n);
  return c.count;
}
export function returned(n: number): Collector {
  const c = new Collector();
  fill(c, n);
  return c;
}
export function inCase(n: number): number {
  switch (n) {
    case 1:
      const c = new Collector();
      fill(c, n);
      return c.count;
    default:
      return 0;
  }
}
class Link { next: Link | null = null; readonly id: number; constructor(id: number) { this.id = id; } }
export function chain(n: number): number {
  const head = new Link(0);
  let tail = new Link(1);
  head.next = tail;
  for (let i = 2; i < n; i++) { const l = new Link(i); tail.next = l; tail = l; }
  tail.next = head.next;
  return head.next.id + (head.next.next?.id ?? 0);
}
console.log(local(2), stored(1), assigned(1), returned(1).count, inCase(1), chain(4), kept.length, outer !== null);
`;

test("class instances that own references live in frame storage while they stay in the frame", async () => {
  const ir = emitLlvmModule(await moduleFor(COLLECTORS));
  const local = body(ir, "local");
  expect(local).toMatch(/alloca %sc_o_Collector, align 8/);
  expect(local).not.toContain("@sc_new_Collector()");
  expect(local).toContain("store i64 -1, ptr");
  // The frame releases the reference fields when the binding's scope exits.
  expect(local).toMatch(/call void @scr_arr_release\(/);
  // A cycle-capable class keeps its collector header in front of the object.
  const chain = body(ir, "chain");
  expect(chain).toMatch(/alloca \{ \[8 x i8\], %sc_o_Link \}, align 8/);
  expect(chain).toContain("store i32 -1, ptr");
  // Stored, assigned to another binding, returned, or declared in a switch
  // case: the instance stays on the heap.
  for (const name of ["stored", "assigned", "returned", "inCase"]) {
    const fn = body(ir, name);
    expect(fn, name).not.toMatch(/alloca %sc_o_Collector/);
    expect(fn, name).toContain("@sc_new_Collector()");
  }
});

test("fresh instances passed in place and instances captured by invoked closures live in frame storage", async () => {
  const ir = emitLlvmModule(
    await moduleFor(`
class Checker {
  readonly names: string[];
  readonly seen = new Set<string>();
  constructor(names: string[]) { this.names = names; }
  check(): number { let d = 0; for (const n of this.names) { if (this.seen.has(n)) d++; this.seen.add(n); } return d; }
}
function each(xs: number[], f: (x: number) => void): void { for (const x of xs) f(x); }
class Totals {
  readonly seen: number[] = [];
  total = 0;
  add(x: number): void { this.total += x; this.seen.push(x); }
  addAll(xs: number[]): void { each(xs, (x) => this.add(x)); }
}
const handlers: ((x: number) => void)[] = [];
export function inPlace(names: string[]): number { return new Checker(names).check(); }
export function captured(xs: number[]): number {
  const t = new Totals();
  t.addAll(xs);
  each(xs, (x) => t.add(x * 2));
  return t.total;
}
export function kept(xs: number[]): number {
  const t = new Totals();
  handlers.push((x) => t.add(x));
  return t.total;
}
console.log(inPlace(["a", "a"]), captured([1, 2]), kept([3]), handlers.length);
`),
  );
  const inPlace = body(ir, "inPlace");
  expect(inPlace).toMatch(/alloca %sc_o_Checker, align 8/);
  expect(inPlace).not.toContain("@sc_new_Checker()");
  const captured = body(ir, "captured");
  expect(captured).toMatch(/alloca %sc_o_Totals, align 8/);
  expect(captured).not.toContain("@sc_new_Totals()");
  // A closure that outlives the call keeps its captured instance on the heap.
  const kept = body(ir, "kept");
  expect(kept).not.toMatch(/alloca %sc_o_Totals/);
  expect(kept).toContain("@sc_new_Totals()");
});

test("a nullable class field in frame storage is released as the class pointer it holds", async () => {
  const ir = emitLlvmModule(
    await moduleFor(`
class Tag { readonly name: string; constructor(name: string) { this.name = name; } }
const seen = new Set<Tag | null>();
const counts = new Map<Tag | null, number>();
class Holder {
  tag: Tag | null = null;
  set(name: string): void { this.tag = new Tag(name); }
}
export function label(names: string[]): string {
  const h = new Holder();
  for (const n of names) h.set(n);
  seen.add(h.tag);
  counts.set(h.tag, 1);
  return h.tag?.name ?? "-";
}
console.log(label(["a"]), seen.size, counts.size);
`),
  );
  const label = body(ir, "label");
  expect(label).toMatch(/alloca %sc_o_Holder, align 8/);
  // The union is boxed where it is a Set element or Map key, but the field
  // keeps the raw pointer: its release at scope exit is the class release.
  const field = /(%s\d+) = getelementptr inbounds %sc_o_Holder, ptr %s\d+, i64 0, i32 1/.exec(
    label,
  )![1]!;
  const release = new RegExp(
    `(%t\\d+) = load ptr, ptr ${field}\\n\\s+call void (@\\w+)\\(ptr \\1\\)`,
  ).exec(label);
  expect(release?.[2]).toBe("@sc_release_Tag");
});
