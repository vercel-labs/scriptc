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

const groups = `
class Tally {
  n = 0;
  add(): void { this.n++; }
}
interface Settings { groups: VALUE }
function addGroup(settings: Settings, name: string): void {
  settings.groups[name] = {};
}
const settings: Settings = { groups: {} };
const tally = new Tally();
addGroup(settings, String(tally.n));
tally.add();
console.log(tally.n, Object.keys(settings.groups));
`;

test("a computed write into a dictionary of dictionaries leaves method calls direct", async () => {
  const source = groups.replace("VALUE", "Record<string, Record<string, string>>");
  expect(await callersOf(source, "%dyn.class.properties")).toEqual([]);
});

test("a computed write into a dictionary that can hold functions keeps checked dispatch", async () => {
  const source = groups.replace("VALUE", "Record<string, Record<string, string> | (() => void)>");
  expect(await callersOf(source, "%dyn.class.properties")).not.toEqual([]);
});
