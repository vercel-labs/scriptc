import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** Names of the functions whose bodies call `callee`. */
async function callersOf(source: string, callee: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-method-mutations-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    return mod.functions
      .filter((fn) => JSON.stringify(fn.body).includes(`"callee":"${callee}"`))
      .map((fn) => fn.name);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const reporter = `
type ErrorCallback = (message: string) => void;
class Scanner {
  private onError: ErrorCallback | undefined = undefined;
  setOnError(onError: ErrorCallback | undefined): void { this.onError = onError; }
  fail(message: string): void { if (this.onError !== undefined) this.onError(message); }
}
class Reporter {
  count = 0;
  onError(message: string): void { this.count = this.count + message.length; }
}
const reporter = new Reporter();
const scanner = new Scanner();
scanner.setOnError((message) => reporter.onError(message));
scanner.fail("bad");
console.log(reporter.count);
`;

test("a callback field sharing a method's name leaves the method's calls direct", async () => {
  expect(await callersOf(reporter, "%dyn.class.properties")).toEqual([]);
});

test("an interface-typed write that can reach a method keeps checked dispatch", async () => {
  const relabeled = `${reporter}
interface Errors { onError: (message: string) => void; }
function silence(target: Errors): void { target.onError = () => {}; }
silence(reporter);
reporter.onError("again");
console.log(reporter.count);
`;
  expect(await callersOf(relabeled, "%dyn.class.properties")).not.toEqual([]);
});

const counter = `
class Counter {
  n = 0;
  bump(): void { this.n++; }
}
function clear(slots: (Counter | null)[], positions: Map<string, number>, key: string): void {
  const at = positions.get(key);
  if (at !== undefined || slots.length > 0) KEY;
}
const counter = new Counter();
clear([counter], new Map([["a", 0]]), "a");
counter.bump();
console.log(counter.n);
`;

test("an asserted number key leaves method calls direct", async () => {
  for (const write of [
    "slots[at as number] = null",
    "slots[at!] = null",
    "slots[<number>at] = null",
  ])
    expect(await callersOf(counter.replace("KEY", write), "%dyn.class.properties")).toEqual([]);
});

test("an asserted string key keeps checked dispatch", async () => {
  const source = counter.replace(
    "KEY",
    "(slots as unknown as Record<string, unknown>)[String(at) as string] = null",
  );
  expect(await callersOf(source, "%dyn.class.properties")).not.toEqual([]);
});

const tally = `
class Tally {
  n = 0;
  add(): void { this.n++; }
}
function entry(target: object, key: string, value: number): TYPE {
  return LITERAL;
}
const tally = new Tally();
tally.add();
console.log(tally.n, Object.keys(entry(tally, String(tally.n), 2)));
`;

test("a computed key in an object literal leaves method calls direct", async () => {
  const source = tally
    .replace("TYPE", "Record<string, number>")
    .replace("LITERAL", "{ [key]: value }");
  expect(await callersOf(source, "%dyn.class.properties")).toEqual([]);
});

test("a computed key in an Object.assign source keeps checked dispatch", async () => {
  const source = tally
    .replace("TYPE", "object")
    .replace("LITERAL", "Object.assign(target, { [key]: value })");
  expect(await callersOf(source, "%dyn.class.properties")).not.toEqual([]);
});

const range = `
class Range {
  hi: number;
  constructor(hi: number) { this.hi = hi; }
  *[Symbol.iterator](): Generator<number> { for (let i = 0; i < this.hi; i++) yield i; }
}
const r = new Range(3);
console.log(r[Symbol.iterator]().next().value);
`;

test("a well-known symbol method call lowers to the class's method", async () => {
  expect(await callersOf(range, "%Range.sym:iterator")).not.toEqual([]);
});

test("a reflection call with a well-known symbol key keeps checked dispatch", async () => {
  const write = "Object.defineProperty(r, Symbol.iterator, { value: function* () {} });\n";
  // The checked path reads the declared method through its value thunk.
  const callers = await callersOf(`${range}${write}`, "%Range.sym:iterator");
  expect(callers.filter((name) => !name.startsWith("%method.value:"))).toEqual([]);
});

const dictionaries = `
class Counter {
  n = 0;
  add(): number { return ++this.n; }
}
interface Settings { groups: Record<string, Record<string, string>> }
interface Tree { [key: string]: Tree }
function addGroup(settings: Settings, name: string): void {
  settings.groups[name] = {};
}
function grow(tree: Tree, name: string): void {
  tree[name] = {};
}
const settings: Settings = { groups: {} };
addGroup(settings, "colours");
grow({}, "a");
const counter = new Counter();
console.log(counter.add(), Object.keys(settings.groups));
`;

test("a store into a dictionary of dictionaries leaves method calls direct", async () => {
  expect(await callersOf(dictionaries, "%dyn.class.properties")).toEqual([]);
});

test("a store into a dictionary whose values can be functions keeps checked dispatch", async () => {
  const source = dictionaries.replace(
    "Record<string, Record<string, string>>",
    "Record<string, Record<string, string> | (() => number)>",
  );
  expect(await callersOf(source, "%dyn.class.properties")).not.toEqual([]);
});

test("a store into a generic dictionary of dictionaries keeps checked dispatch", async () => {
  const source = dictionaries
    .replace(
      "interface Settings { groups: Record<string, Record<string, string>> }",
      "interface Settings<T> { groups: Record<string, Record<string, T>> }",
    )
    .replace("function addGroup(settings: Settings,", "function addGroup<T>(settings: Settings<T>,")
    .replace("const settings: Settings =", "const settings: Settings<string> =");
  expect(await callersOf(source, "%dyn.class.properties")).not.toEqual([]);
});

test("a runtime-key store into a dictionary view of a class instance keeps checked dispatch", async () => {
  const source = `
class Counter {
  n = 0;
  tick(): number { return ++this.n; }
}
const counter = new Counter();
const view: {} = counter;
const slots: Record<string, string> = view;
const key: string = String(process.argv.length);
slots[key] = "replaced";
console.log(counter.tick());
`;
  // The method has a slot the write can replace, which calls consult.
  expect(await callersOf(source, "%Counter.tick")).toContain("%method.value:%Counter.tick");
});

test("a dot store into a dictionary view of a class instance keeps checked dispatch", async () => {
  const source = `
class Lamp {
  on = false;
  toggle(): boolean { this.on = !this.on; return this.on; }
}
const lamp = new Lamp();
const view: {} = lamp;
const slots: Record<string, string> = view;
slots.toggle = "replaced";
console.log(lamp.toggle());
`;
  // The method has a slot the write can replace, which calls consult.
  expect(await callersOf(source, "%Lamp.toggle")).toContain("%method.value:%Lamp.toggle");
});
