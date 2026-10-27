import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-class-layouts-"));
  try {
    const entry = join(dir, "main.js"),
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

/** Field name → IR kind for a class, and whether it tracks field creation. */
function layout(module: IrModule, name: string): { fields: string; tracks: boolean } {
  const cls = module.classes.find((candidate) => candidate.name === name);
  expect(cls, name).toBeDefined();
  return {
    fields: cls!.fields
      .filter((field) => !field.name.startsWith("%"))
      .map((field) => `${field.name}:${field.type.kind}`)
      .join(" "),
    tracks: cls!.tracksOwnFields === true,
  };
}

function params(module: IrModule, name: string): string {
  const fn = module.functions.find((candidate) => candidate.name === name);
  expect(fn, name).toBeDefined();
  return `(${fn!.params.map((param) => param.type.kind).join(", ")}): ${fn!.returnType.kind}`;
}

function calls(module: IrModule, name: string): string[] {
  const fn = module.functions.find((candidate) => candidate.name === name);
  expect(fn, name).toBeDefined();
  return [...JSON.stringify(fn!.body).matchAll(/"callee":"([^"]+)"/g)].map((match) => match[1]!);
}

const SHAPES = `
class Shape {
  constructor() {
    this.sides = 0;
    this.label = "shape";
  }
  reset() {
    this.sides = 0;
  }
}
class Square extends Shape {
  constructor() {
    super();
    this.sides = 4;
    this.size = 2;
  }
}
const shapes = [new Shape(), new Square()];
for (let i = 0; i < shapes.length; i++) shapes[i].reset();
console.log(shapes.length);
`;

test("JavaScript fields created before the instance escapes need no creation tracking", async () => {
  const module = await lower(SHAPES);
  expect(layout(module, "Shape")).toEqual({ fields: "sides:f64 label:string", tracks: false });
  expect(layout(module, "Square")).toEqual({
    fields: "sides:f64 label:string size:f64",
    tracks: false,
  });
});

test("JavaScript fields created after the instance escapes keep creation tracking", async () => {
  const escaped = await lower(`
class Node {
  constructor(list) {
    list.push(this);
    this.id = list.length;
  }
  touch() {
    this.id++;
  }
}
const node = new Node([]);
node.touch();
console.log(node.id);
`);
  expect(layout(escaped, "Node").tracks).toBe(true);
  const deleted = await lower(`${SHAPES}
const loose = /** @type {any} */ (shapes[0]);
delete loose.label;
`);
  expect(layout(deleted, "Shape").tracks).toBe(true);
});

test("freezing values other than class instances keeps JavaScript class layouts fixed", async () => {
  const module = await lower(`${SHAPES}
/** @param {{ value: any }} data */
function settle(data) {
  data.value = Object.freeze(data.value);
  Object.seal(data);
  return Object.preventExtensions(data.value);
}
settle({ value: { sides: 1 } });
const square = new Square();
Object.freeze(square);
`);
  expect(layout(module, "Shape").tracks).toBe(false);
  expect(layout(module, "Square").tracks).toBe(false);
});

test("accessors that share no field's name keep JavaScript class layouts fixed", async () => {
  const module = await lower(`
class Path {
  constructor(key) {
    this.cache = [];
    this.key = key;
  }
  get path() {
    if (!this.cache.length) this.cache.push(this.key);
    return this.cache;
  }
}
class Named extends Path {
  constructor(key) {
    super(key);
    this.label = "named";
  }
  /** @param {string} value */
  set label2(value) {
    this.label = value;
  }
}
console.log(new Named("k").path.length);
`);
  expect(layout(module, "Path")).toEqual({ fields: "cache:dyn key:dyn", tracks: false });
  expect(layout(module, "Named").tracks).toBe(false);
  expect(layout(module, "Named").fields).toBe("cache:dyn key:dyn label:string");
});

test("JavaScript subclass fields keep their types when the base constructor only assigns fields", async () => {
  const module = await lower(`
class Base {
  constructor() {
    this.ready = true;
    this.report();
  }
  report() {}
}
class Late extends Base {
  constructor() {
    super();
    this.count = 1;
  }
}
console.log(new Late().count);
${SHAPES}`);
  expect(layout(module, "Square").fields).toBe("sides:f64 label:string size:f64");
  expect(layout(module, "Late").fields).toBe("ready:bool count:dyn");
});

test("method calls on possibly missing JavaScript array elements dispatch natively", async () => {
  const module = await lower(SHAPES);
  expect(calls(module, "%init.0")).toContain("%Shape.reset");
  expect(calls(module, "%init.0").some((callee) => callee.startsWith("%dyn.class.call"))).toBe(
    false,
  );
});

const ACCOUNTS = `
class Account {
  /** @param {string} owner @param {number} balance */
  constructor(owner, balance) {
    this.owner = owner;
    this.balance = balance;
  }
  /** @returns {number} */
  fee() {
    return this.balance > 100 ? 0 : 1;
  }
  close() {
    this.balance = 0;
  }
}
class Savings extends Account {
  /** @param {string} owner @param {number} balance */
  constructor(owner, balance) {
    super(owner, balance);
    this.rate = 2;
  }
  /** @returns {number} */
  fee() {
    return 0;
  }
}
/** @type {Account[]} */
const accounts = [new Account("a", 1), new Savings("b", 2)];
let fees = 0;
for (let i = 0; i < accounts.length; i++) {
  fees += accounts[i].fee();
  accounts[i].close();
}
console.log(fees);
`;

test("a JavaScript file TypeScript checks uses its JSDoc types for class layouts", async () => {
  const checked = await lower(`// @ts-check\n${ACCOUNTS}`);
  expect(layout(checked, "Account").fields).toBe("owner:string balance:f64");
  expect(params(checked, "%Account.constructor")).toBe("(object, string, f64): void");
  expect(params(checked, "%Savings.fee")).toBe("(object): f64");
  expect(calls(checked, "%init.0").some((callee) => callee.startsWith("%dyn.class."))).toBe(false);
  const unchecked = await lower(ACCOUNTS);
  expect(layout(unchecked, "Account").fields).toBe("owner:dyn balance:dyn");
  expect(params(unchecked, "%Account.constructor")).toBe("(object, dyn, dyn): void");
});

test("instances of a class with subclasses box at their exact class", async () => {
  const module = await lower(`${SHAPES}
/** @param {any} value */
function keep(value) {
  return value;
}
/** @param {Shape} shape */
function cross(shape) {
  return keep(shape);
}
console.log(cross(new Square()).size, cross(new Shape()).label);
`);
  const helper = module.functions.find((fn) => fn.name === "%dyn.class.boxExact:Shape");
  expect(helper).toBeDefined();
  expect(calls(module, "cross")).toContain("%dyn.class.boxExact:Shape");
  expect(JSON.stringify(helper!.body)).toContain('"className":"Square"');
});
