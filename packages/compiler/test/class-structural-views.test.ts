import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The IR type kind of each named module-level binding. */
async function globalKinds(source: string): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-structural-views-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    return Object.fromEntries((mod.globals ?? []).map((g) => [g.name, g.type.kind]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The IR type kind of every member of the record shape that declares
 * `field`. */
async function recordFields(source: string, field: string): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-class-structural-views-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    for (const record of mod.records ?? []) {
      const kinds = Object.fromEntries(record.fields.map((f) => [f.name, f.type.kind]));
      if (field in kinds) return kinds;
    }
    throw new Error(`no record shape declares ${field}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A class that writes its own fields after construction, an interface it
 * conforms to, and a record member of that interface type: the shape of the
 * member reports what the interface type lowered to. */
function shapeOfPoint(after: string): string {
  return `
interface Point { x: number; y: number }
interface Document { origin: Point; name: string }
class Cursor {
  x = 1;
  y = 2;
  step(dx: number): void { this.x += dx; }
}
const cursor = new Cursor();
${after}
const parsed = JSON.parse("{}") as Document;
console.log(JSON.stringify(parsed));
`;
}

test("an instance passed to a callee that reads its fields keeps the interface a record", async () => {
  // distance reads p.x and p.y and computes with a Math builtin: the copy
  // built at the call answers the same reads, so Point stays a record.
  const kinds = await recordFields(
    shapeOfPoint(`
function distance(p: Point): number { return Math.sqrt(p.x * p.x + p.y * p.y); }
console.log(distance(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("record");
  expect(kinds["name"]).toBe("string");
});

test("an instance passed to a const arrow callee keeps the interface a record", async () => {
  const kinds = await recordFields(
    shapeOfPoint(`
const distance = (p: Point): number => Math.sqrt(p.x * p.x + p.y * p.y);
console.log(distance(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("record");
});

test("an instance passed to a reassignable callee keeps the interface a live view", async () => {
  // A `let` binding can run a function this analysis never saw.
  const kinds = await recordFields(
    shapeOfPoint(`
let distance = (p: Point): number => p.x;
console.log(distance(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("an instance a binding also receives keeps the interface a live view", async () => {
  // The binding reads the interface's member after the instance changed, so
  // the interface keeps the live view and the record member stays dynamic.
  const kinds = await recordFields(
    shapeOfPoint(`
const view: Point = cursor;
cursor.step(1);
console.log(view.x);
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a callee that writes through its parameter keeps the interface a live view", async () => {
  const kinds = await recordFields(
    shapeOfPoint(`
function bump(p: Point): void { p.x += 1; }
bump(cursor);
console.log(cursor.x);
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a callee that keeps the parameter past the call keeps the interface a live view", async () => {
  const kinds = await recordFields(
    shapeOfPoint(`
function hold(p: Point): () => number { return () => p.x; }
const held = hold(cursor);
cursor.step(1);
console.log(held());
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a callee that reads an object field keeps the interface a live view", async () => {
  // A member of object type is not a value the callee reads once: the copy
  // would hand it a different value than the instance holds.
  const kinds = await recordFields(
    `
interface Point { x: { depth: number }; y: number }
interface Document { origin: Point; name: string }
class Cursor {
  x = { depth: 1 };
  y = 2;
  step(dx: number): void { this.x = { depth: this.x.depth + dx }; }
}
function peek(p: Point): number { return p.x.depth; }
console.log(peek(new Cursor()));
const parsed = JSON.parse("{}") as Document;
console.log(JSON.stringify(parsed));
`,
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a later argument that writes the instance keeps the interface a live view", async () => {
  // The copy is made when the argument is evaluated, before the later
  // argument runs: code there could change the fields the callee reads.
  const kinds = await recordFields(
    shapeOfPoint(`
function tick(): number { cursor.x += 1; return 0; }
function read(p: Point, n: number): number { return p.x + n; }
console.log(read(cursor, tick()));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a callee whose other parameter has a default keeps the interface a live view", async () => {
  // Defaults run after the arguments are evaluated, in the callee's own
  // frame, so their code can write the instance after the copy exists.
  const kinds = await recordFields(
    shapeOfPoint(`
function ticker(): number { cursor.x += 1; return 1; }
function read(p: Point, n: number = ticker()): number { return p.x + n; }
console.log(read(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a callee that reads a getter elsewhere keeps the interface a live view", async () => {
  // The getter runs program code while the parameter is in hand, and that
  // code writes the instance: other member reads are not inert.
  const kinds = await recordFields(
    shapeOfPoint(`
const box = { get n(): number { cursor.x += 1; return 1; } };
function read(p: Point): number { return p.x + box.n; }
console.log(read(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a call through a mutable alias of a const function keeps the interface a live view", async () => {
  // The alias can be replaced with a function this analysis never saw, so
  // the arrow alone does not make the callee fixed.
  const kinds = await recordFields(
    shapeOfPoint(`
const read = (p: Point): number => p.x;
let call = read;
call = (p: Point): number => p.x * 2;
console.log(call(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a call through a mutable alias of a function declaration keeps the interface a live view", async () => {
  // The alias resolves to the declaration's signature but runs a body this
  // analysis never saw once it is replaced.
  const kinds = await recordFields(
    shapeOfPoint(`
function read(p: Point): number { return p.x; }
let call = read;
call = (p: Point): number => p.x * 2;
console.log(call(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a compound assignment of a non-primitive local keeps the interface a live view", async () => {
  // `+=` coerces its operands, and a valueOf hook runs program code while
  // the copy is the callee's parameter.
  const kinds = await recordFields(
    shapeOfPoint(`
const patch = { valueOf(): number { cursor.x += 1; return 1; } };
function read(p: Point): number {
  let n: any = 0;
  n += patch;
  return p.x;
}
console.log(read(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("an increment of a non-primitive local keeps the interface a live view", async () => {
  const kinds = await recordFields(
    shapeOfPoint(`
function read(p: Point): number {
  let n: any = { valueOf(): number { cursor.x += 1; return 1; } };
  n++;
  return p.x;
}
console.log(read(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a call to a shadowed parseInt keeps the interface a live view", async () => {
  const kinds = await recordFields(
    shapeOfPoint(`
function parseInt(text: string): number { cursor.x += 1; return text.length; }
function read(p: Point): number { return parseInt("1") + p.x; }
console.log(read(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("a call to a shadowed Math keeps the interface a live view", async () => {
  const kinds = await recordFields(
    shapeOfPoint(`
const Math = { max(a: number, b: number): number { cursor.x += 1; return a + b; } };
function read(p: Point): number { return Math.max(p.x, 1); }
console.log(read(cursor));
`),
    "origin",
  );
  expect(kinds["origin"]).toBe("dyn");
});

test("an optional method in an anonymous union received from a class stays live", async () => {
  const kinds = await globalKinds(`
class SelectList {
  handleInput(data: string): void { console.log("list", data); }
}
const list = new SelectList();
const handler: { handleInput?(data: string): void } | undefined = list;
handler?.handleInput?.("a");
`);
  // The union collapses to the checked dynamic slot that holds the instance.
  expect(kinds["handler"]).toBe("dyn");
});

test("an optional method interface received from a class stays live", async () => {
  const kinds = await globalKinds(`
interface Input {
  handleInput?(data: string): void;
}
class SelectList {
  handleInput(data: string): void { console.log("list", data); }
}
const list = new SelectList();
const handler: Input | undefined = list;
handler?.handleInput?.("a");
`);
  expect(kinds["handler"]).toBe("dyn");
});

test("a required method in a plain anonymous slot received from a class stays live", async () => {
  const kinds = await globalKinds(`
class Button {
  presses = 0;
  press(): void { this.presses++; console.log("press", this.presses); }
}
const button = new Button();
const handler: { press(): void } = button;
handler.press();
console.log(button.presses);
`);
  expect(kinds["handler"]).toBe("dyn");
  // The instance itself keeps its nominal class.
  expect(kinds["button"]).toBe("object");
});

test("a data-only anonymous type keeps the instance it names", async () => {
  const kinds = await globalKinds(`
class Point { x = 1; y = 2; }
const point = new Point();
const copy: { x: number; y: number } = point;
console.log(copy.x + copy.y);
`);
  // Every member of the record is a field of the instance at the same type,
  // so the binding holds the instance: a write through either name is seen
  // through the other, and JSON keeps the fields Node's object carries.
  expect(kinds["copy"]).toBe("object");
  expect(kinds["point"]).toBe("object");
});

test("an anonymous type that only receives an object literal keeps its record layout", async () => {
  const kinds = await globalKinds(`
const handler: { press?: () => void } = {
  press() { console.log("literal"); },
};
handler.press?.();
`);
  expect(kinds["handler"]).toBe("record");
});

test("a named alias of Pick over a class stays a live view", async () => {
  const kinds = await globalKinds(`
class Counter {
  count = 0;
  tick(): number { this.count += 1; return this.count; }
  peek(): number { return this.count; }
}
type Tickable = Pick<Counter, "tick">;
const counter = new Counter();
const view: Tickable = counter;
console.log(view.tick(), counter.count);
`);
  expect(kinds["view"]).toBe("dyn");
  expect(kinds["counter"]).toBe("object");
});

test("a named alias of Omit over a class stays a live view", async () => {
  const kinds = await globalKinds(`
class Counter {
  count = 0;
  tick(): number { this.count += 1; return this.count; }
  peek(): number { return this.count; }
}
type Peekable = Omit<Counter, "tick">;
const counter = new Counter();
const view: Peekable = counter;
console.log(view.peek());
`);
  expect(kinds["view"]).toBe("dyn");
});

test("an alias of an alias of Pick over a class stays a live view", async () => {
  const kinds = await globalKinds(`
class Counter {
  count = 0;
  tick(): number { this.count += 1; return this.count; }
}
type Tickable = Pick<Counter, "tick">;
type AlsoTickable = Tickable;
const counter = new Counter();
const view: AlsoTickable = counter;
console.log(view.tick());
`);
  expect(kinds["view"]).toBe("dyn");
});

test("a Map received as a record with one of its members stays the collection", async () => {
  const kinds = await globalKinds(`
type Exists = { has(key: string): boolean };
const byId = new Map<string, number>();
const view: Exists = byId;
console.log(view.has("a"), byId.has("a"));
`);
  expect(kinds["view"]).toBe("dyn");
});

test("a Set received as a record with one of its members stays the collection", async () => {
  const kinds = await globalKinds(`
type Exists = { has(key: string): boolean };
const seen = new Set<string>();
const view: Exists = seen;
console.log(view.has("a"), seen.has("a"));
`);
  expect(kinds["view"]).toBe("dyn");
});

test("an interface that extends Error received from an error stays the error", async () => {
  const kinds = await globalKinds(`
interface HttpError extends Error {
  status: number | undefined;
  body: string;
}
function fail(): HttpError {
  const error = new Error("x") as HttpError;
  error.status = 500;
  error.body = "b";
  return error;
}
const failure = fail();
console.log(failure.status, failure instanceof Error);
`);
  expect(kinds["failure"]).toBe("dyn");
});
