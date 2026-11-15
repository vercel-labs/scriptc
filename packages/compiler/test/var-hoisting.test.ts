import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";
import type { IrModule, IrType } from "../src/ir/ir.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lower(source: string, file = "main.ts"): Promise<IrModule> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-var-hoisting-"));
  directories.push(outDir);
  const entry = join(outDir, file);
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ir");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "ir" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return JSON.parse(await readFile(outPath, "utf8")) as IrModule;
}

function globalType(mod: IrModule, name: string): IrType["kind"] | undefined {
  return mod.globals?.find((g) => g.name === name)?.type.kind;
}

test("only vars readable before their first store get undefined-armed storage", async () => {
  const mod = await lower(`
function early(): number { return late; }
console.log(early());
var late = 5;
var settled = 1;
function read(): number { return settled; }
console.log(read(), early());
for (var i = 0; i < 2; i++) settled += i;
console.log(i);
`);
  expect(globalType(mod, "late")).toBe("union");
  expect(globalType(mod, "settled")).toBe("f64");
  expect(globalType(mod, "i")).toBe("f64");
});

test("a hoisted function counts as early only when a call can run first", async () => {
  const mod = await lower(`
var before = 1;
console.log(after());
var later = 2;
function after(): number { return before + later; }
console.log(after());
`);
  expect(globalType(mod, "before")).toBe("f64");
  expect(globalType(mod, "later")).toBe("union");
});

test("JavaScript loop and initialized vars keep plain storage", async () => {
  const mod = await lower(
    `
var count = 0;
for (var i = 0; i < 3; i++) count += i;
for (var key in { a: 1 }) count += key.length;
function read() { return count + i; }
console.log(read());
`,
    "main.js",
  );
  expect(globalType(mod, "count")).toBe("f64");
  expect(globalType(mod, "i")).toBe("f64");
});

function localType(mod: IrModule, fn: string, name: string): IrType["kind"] | undefined {
  return mod.functions.find((f) => f.name === fn)?.locals.find((l) => l.name === name)?.type.kind;
}

test("a let without an initializer that a function can read early holds undefined", async () => {
  const mod = await lower(`
let cache: Map<string, number>;
function memo(key: string): number {
  if (cache === undefined) cache = new Map();
  return cache.get(key) ?? 0;
}
console.log(memo("a"));
let count: number;
function next(): number { return count === undefined ? (count = 1) : ++count; }
console.log(next());
`);
  expect(globalType(mod, "cache")).toBe("union");
  expect(globalType(mod, "count")).toBe("union");
});

test("a let stored before every read keeps its declared storage", async () => {
  const mod = await lower(`
let direct: number;
direct = 1;
function readDirect(): number { return direct; }
let branched: string;
if (direct > 0) branched = "a"; else branched = "b";
const readBranched = (): string => branched;
let guarded: number;
try { guarded = JSON.parse("1") as number; } catch { throw new Error("bad"); }
const readGuarded = (): number => guarded;
let [first, second]: number[] = [1, 2];
let pair: number;
[pair] = [first + second];
const readPair = (): number => pair;
let own: string;
own = "x";
console.log(readDirect(), readBranched(), readGuarded(), readPair(), own);
`);
  for (const name of ["direct", "branched", "guarded", "pair", "own"])
    expect(globalType(mod, name), name).not.toBe("union");
});

test("a store that may be skipped does not settle a let", async () => {
  const mod = await lower(`
const flag: boolean = process.argv.length > 5;
let oneBranch: number;
if (flag) oneBranch = 1;
const readOneBranch = (): number => oneBranch;
let swallowed: number;
try { swallowed = JSON.parse("1") as number; } catch {}
const readSwallowed = (): number => swallowed;
let inLoop: number;
for (let i = 0; i < process.argv.length - 9; i++) inLoop = i;
const readInLoop = (): number => inLoop;
let shortCircuit: number;
flag && (shortCircuit = 1);
const readShortCircuit = (): number => shortCircuit;
let later: number;
const readLater = (): number => later;
console.log(typeof readLater());
later = 2;
console.log(typeof readOneBranch(), typeof readSwallowed(), typeof readInLoop(), typeof readShortCircuit(), readLater());
`);
  for (const name of ["oneBranch", "swallowed", "inLoop", "shortCircuit", "later"])
    expect(globalType(mod, name), name).toBe("union");
});

test("a hoisted function settles a let only when every use comes after the store", async () => {
  const mod = await lower(`
let ready: number;
ready = 1;
console.log(useReady());
function useReady(): number { return ready; }
let pending: number;
console.log(typeof usePending());
pending = 1;
function usePending(): number { return pending; }
let lazy: number;
export function useLazy(): number { return lazy === undefined ? (lazy = 3) : lazy; }
let stored: number;
stored = 4;
export function useStored(): number { return stored; }
`);
  expect(globalType(mod, "ready")).toBe("f64");
  expect(globalType(mod, "pending")).toBe("union");
  expect(globalType(mod, "lazy")).toBe("union");
  expect(globalType(mod, "stored")).toBe("f64");
});

test("a definite-assignment assertion leaves the declaring scope's reads unchecked", async () => {
  const mod = await lower(`
function run(): string {
  let unchecked!: number;
  const before = typeof unchecked;
  unchecked = 1;
  let assigned!: number;
  assigned = 2;
  const sum = unchecked + assigned;
  let checked: number;
  checked = 3;
  return before + sum + checked;
}
console.log(run());
`);
  expect(localType(mod, "run", "unchecked")).toBe("union");
  expect(localType(mod, "run", "assigned")).toBe("f64");
  expect(localType(mod, "run", "checked")).toBe("f64");
});

test("a let in a loop body is early when a closure made before its store reads it", async () => {
  const mod = await lower(`
function run(): number {
  let total = 0;
  for (let i = 0; i < 3; i++) {
    let early: number;
    const peek = (): number => (early === undefined ? 0 : early);
    total += peek();
    early = i;
    let late: number;
    late = i;
    const read = (): number => late;
    total += read() + peek();
  }
  return total;
}
console.log(run());
`);
  expect(localType(mod, "run", "early")).toBe("union");
  expect(localType(mod, "run", "late")).toBe("f64");
});

test("an exported var that only a function stores holds undefined for importers", async () => {
  const mod = await lower(`
var registry: string[];
export function register(name: string): number {
  if (registry === undefined) registry = [];
  return registry.push(name);
}
var settled: string[];
settled = [];
export function count(): number { return settled.length; }
`);
  expect(globalType(mod, "registry")).toBe("union");
  expect(globalType(mod, "settled")).toBe("array");
});

test("a function stored in a binding runs where that binding is used", async () => {
  const mod = await lower(`
let state: number;
const readState = (): number => state;
state = 1;
console.log(readState());
let early: number;
const readEarly = (): number => early;
console.log(typeof readEarly());
early = 2;
let countdown: (n: number) => number;
countdown = (n) => (n <= 0 ? 0 : 1 + countdown(n - 1));
console.log(countdown(3));
let isEven: (n: number) => boolean;
let isOdd: (n: number) => boolean;
isEven = (n) => (n === 0 ? true : isOdd(n - 1));
isOdd = (n) => (n === 0 ? false : isEven(n - 1));
console.log(isEven(4));
let handed: number;
const callbacks: (() => number)[] = [];
callbacks.push(() => handed);
handed = 3;
let asserted: string;
function assign(): void { asserted = "a"; }
assign();
console.log(asserted!.length);
const flag: boolean = process.argv.length > 5;
let maybe: string;
if (flag) maybe = "m";
console.log(typeof maybe!);
`);
  expect(globalType(mod, "state")).toBe("f64");
  expect(globalType(mod, "early")).toBe("union");
  expect(globalType(mod, "countdown")).toBe("func");
  expect(globalType(mod, "isEven")).toBe("func");
  expect(globalType(mod, "isOdd")).toBe("func");
  expect(globalType(mod, "handed")).toBe("union");
  expect(globalType(mod, "asserted")).toBe("union");
  expect(globalType(mod, "maybe")).toBe("union");
});

test("a function binding that can be read early keeps typed storage", async () => {
  const mod = await lower(`
let pick: (xs: number[]) => number;
function install(): void { pick = (xs) => xs.length; }
function use(): number { return pick === undefined ? -1 : pick([1, 2]); }
console.log(use());
install();
console.log(use());
`);
  expect(globalType(mod, "pick")).toBe("union");
});

test("an exported var inside a namespace keeps its storage", async () => {
  const mod = await lower(`
export namespace m {
  export var a = 10;
}
console.log(m.a);
`);
  expect(mod.globals?.find((g) => g.name === "a")?.type.kind).toBe("f64");
});

test("a store earlier in the reading function's own body settles the read", async () => {
  const mod = await lower(`
function walk(values: number[]): number {
  let current: number;
  let total = 0;
  const add = (): void => { total += current; };
  const visit = (value: number): void => {
    current = value;
    add();
  };
  for (const value of values) visit(value);
  let pending: number;
  const flush = (): void => { total += pending; };
  const queue = (value: number): void => {
    flush();
    pending = value;
  };
  if (values.length > 99) queue(1);
  let late: number;
  function hoisted(): number { return late; }
  late = values.length;
  return total + hoisted();
}
console.log(walk([1, 2, 3]));
`);
  expect(localType(mod, "walk", "current")).toBe("f64");
  expect(localType(mod, "walk", "pending")).toBe("union");
  expect(localType(mod, "walk", "late")).toBe("f64");
});

test("a branch that ends in a call that never returns leaves the statement list", async () => {
  const mod = await lower(`
function fail(message: string): never { throw new Error(message); }
const flag: boolean = process.argv.length > 5;
let chosen: number;
if (flag) chosen = 1;
else fail("no choice");
const readChosen = (): number => chosen;
let loaded: number;
try { loaded = JSON.parse("1") as number; } catch { process.exit(1); }
const readLoaded = (): number => loaded;
let logged: number;
if (flag) logged = 1;
else console.log("not stored");
const readLogged = (): number => logged;
console.log(readChosen(), readLoaded(), typeof readLogged());
`);
  expect(globalType(mod, "chosen")).toBe("f64");
  expect(globalType(mod, "loaded")).toBe("f64");
  expect(globalType(mod, "logged")).toBe("union");
});

/** The errors the module's code can throw through `error.nodeThrow`, as
 * `code: message`. */
function nodeThrows(mod: IrModule): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const expr = node as { kind?: string; fn?: string; args?: { value?: unknown }[] };
    if (expr.kind === "libCall" && expr.fn === "error.nodeThrow")
      out.push(`${String(expr.args?.[1]?.value)}: ${String(expr.args?.[2]?.value)}`);
    Object.values(node).forEach(visit);
  };
  visit(mod.functions);
  return out;
}

test("a required library callback reads an early-read binding's function", async () => {
  const mod = await lower(`
import { EventEmitter } from "node:events";
function wire(emitter: EventEmitter): void {
  let heard: (text: string) => void;
  let visit: (value: number) => void;
  const install = (): void => {
    heard = (text) => console.log(text);
    visit = (value) => console.log(value);
  };
  const arm = (): void => {
    emitter.on("word", heard);
    [1, 2].forEach(visit);
  };
  install();
  arm();
}
wire(new EventEmitter());
`);
  expect(localType(mod, "wire", "heard")).toBe("union");
  expect(localType(mod, "wire", "visit")).toBe("union");
  expect(nodeThrows(mod)).toEqual(
    expect.arrayContaining([
      'ERR_INVALID_ARG_TYPE: The "listener" argument must be of type function. Received undefined',
      ": undefined is not a function",
    ]),
  );
});

test("an optional library callback and a program function keep the stored value", async () => {
  const mod = await lower(`
function call(run: (text: string) => string): string {
  return run === undefined ? "absent" : run("present");
}
function wire(): void {
  let replace: (key: string, value: unknown) => unknown;
  let map: (text: string) => string;
  const install = (): void => {
    replace = (key, value) => value;
    map = (text) => text;
  };
  const arm = (): void => {
    console.log(JSON.stringify({ a: 1 }, replace));
    void Promise.resolve("x").then(map);
    console.log(call(map));
  };
  if (process.argv.length > 5) install();
  arm();
}
wire();
`);
  expect(localType(mod, "wire", "replace")).toBe("union");
  expect(localType(mod, "wire", "map")).toBe("union");
  expect(
    nodeThrows(mod).filter((thrown) => /must be of type function|: undefined is not/.test(thrown)),
  ).toEqual([]);
});

test("observable arguments after a required library callback are evaluated before its check", async () => {
  const mod = await lower(`
function delay(): number { console.log("delay"); return 1; }
function wire(): void {
  let fire: () => void;
  const install = (): void => { fire = () => console.log("fired"); };
  const arm = (): void => {
    setTimeout(fire, delay());
  };
  if (process.argv.length > 5) install();
  arm();
}
wire();
`);
  expect(localType(mod, "wire", "fire")).toBe("union");
  const arm = mod.functions.find((f) => f.locals.some((l) => l.name === "%callOperand"));
  expect(arm).toBeDefined();
  // The binding's value, the later argument, the check, then the call.
  const order = JSON.stringify(arm!.body);
  const held = order.indexOf("%callbackArg");
  const later = order.indexOf('"callee":"delay"');
  const check = order.indexOf("ERR_INVALID_ARG_TYPE");
  expect(held).toBeGreaterThan(-1);
  expect(later).toBeGreaterThan(held);
  expect(check).toBeGreaterThan(later);
});

test("a deferred callback check holds the receiver and the arguments in source order", async () => {
  const mod = await lower(`
function wire(): void {
  let visit: (n: number) => void;
  const install = (): void => { visit = (n) => console.log(n); };
  let list = [1, 2];
  const swap = (): number => { list = [9]; return 1; };
  const arm = (): void => {
    list.forEach(visit, swap());
    [3].forEach(visit, swap());
  };
  if (process.argv.length > 5) install();
  arm();
}
wire();
`);
  const arm = mod.functions.find((f) => f.locals.some((l) => l.name === "%callOperand"));
  expect(arm).toBeDefined();
  // `list` can be assigned by the later argument, so its value is held with
  // the argument's; the literal receiver stays in the call.
  expect(arm!.locals.filter((l) => l.name === "%callOperand").length).toBe(3);
  expect(arm!.locals.filter((l) => l.name === "%callbackArg").length).toBe(2);
});
