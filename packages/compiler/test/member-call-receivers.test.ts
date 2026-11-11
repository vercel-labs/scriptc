// A member call on a record passes the record as the call's receiver only
// where a function that reads the receiver of its call can be the member's
// value. A program with no such function lowers its member calls as before.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrRecord = Record<string, unknown>;

function recordsOf(value: unknown, out: IrRecord[] = []): IrRecord[] {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) recordsOf(item, out);
    return out;
  }
  const record = value as IrRecord;
  out.push(record);
  for (const child of Object.values(record)) recordsOf(child, out);
  return out;
}

/** The calls through a value in a program's IR that carry a receiver, and
 * those that do not. */
async function valueCalls(body: string[]): Promise<{ carried: number; plain: number }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-member-receiver-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const calls = recordsOf(module).filter((node) => node["kind"] === "callValue");
    const carried = calls.filter((node) => node["receiver"] !== undefined).length;
    return { carried, plain: calls.length - carried };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HANDLERS = [
  "interface Handlers { onDone: (x: number) => number; onError: (x: number) => number }",
  "function run(h: Handlers): number { return h.onDone(1) + h.onError(2); }",
];

test("a program with no function that reads its receiver passes none", async () => {
  const calls = await valueCalls([
    ...HANDLERS,
    "function make(onDone: (x: number) => number): Handlers {",
    "  return { onDone, onError: (x) => x };",
    "}",
    "console.log(run(make((x) => x + 1)));",
    "",
  ]);
  expect(calls).toEqual({ carried: 0, plain: 2 });
});

test("a member that stores a receiver-reading function carries; an arrow member does not", async () => {
  const calls = await valueCalls([
    ...HANDLERS,
    "function count(this: Handlers, x: number): number { return this === undefined ? 0 : x; }",
    "const handlers: Handlers = { onDone: count, onError: (x) => x };",
    "console.log(run(handlers));",
    "",
  ]);
  expect(calls).toEqual({ carried: 1, plain: 1 });
});

test("a receiver-reading function that is only called directly marks no member", async () => {
  const calls = await valueCalls([
    ...HANDLERS,
    "function count(this: unknown, x: number): number { return this === undefined ? 0 : x; }",
    "function make(onDone: (x: number) => number): Handlers {",
    "  return { onDone, onError: (x) => x };",
    "}",
    "console.log(run(make((x) => x + 1)), count.call(undefined, 1));",
    "",
  ]);
  expect(calls).toEqual({ carried: 0, plain: 2 });
});

test("a receiver-reading function passed as an argument escapes: the member a parameter is stored under carries, the arrow member does not", async () => {
  const calls = await valueCalls([
    ...HANDLERS,
    "function count(this: unknown, x: number): number { return this === undefined ? 0 : x; }",
    "function make(onDone: (x: number) => number): Handlers {",
    "  return { onDone, onError: (x) => x };",
    "}",
    "console.log(run(make(count as (x: number) => number)));",
    "",
  ]);
  expect(calls).toEqual({ carried: 1, plain: 1 });
});

test("a store under a computed key that folds to a name marks that member", async () => {
  const calls = await valueCalls([
    ...HANDLERS,
    "function count(this: unknown, x: number): number { return this === undefined ? 0 : x; }",
    'const handlers: Handlers = { ["onDone"]: count as (x: number) => number, onError: (x) => x };',
    "console.log(run(handlers));",
    "",
  ]);
  expect(calls).toEqual({ carried: 1, plain: 1 });
});

test("a receiver-reading function returned from a function escapes: the member a parameter is stored under carries, the arrow member does not", async () => {
  const calls = await valueCalls([
    ...HANDLERS,
    "function count(this: unknown, x: number): number { return this === undefined ? 0 : x; }",
    "function pick(): (x: number) => number { return count as (x: number) => number; }",
    "function make(onDone: (x: number) => number): Handlers {",
    "  return { onDone, onError: (x) => x };",
    "}",
    "console.log(run(make(pick())));",
    "",
  ]);
  expect(calls).toEqual({ carried: 1, plain: 1 });
});

test("a wrapper that forwards its receiver escapes, and members that only hold arrows stay as they were", async () => {
  const program = (onDone: string): string[] => [
    ...HANDLERS,
    "function wrap<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {",
    "  return function (this: unknown, ...args: A): R {",
    "    return fn.apply(this, args);",
    "  };",
    "}",
    `const handlers: Handlers = { onDone: ${onDone}, onError: (x) => x };`,
    "const first = wrap((x: number) => x * 2);",
    "console.log(run(handlers) + first(3));",
    "",
  ];
  // The one receiver is the wrapper's own `fn.apply(this, args)`.
  expect(await valueCalls(program("(x) => x + 1"))).toMatchObject({ carried: 1 });
  // The wrapper's result stored in a member: that member carries too.
  expect(await valueCalls(program("wrap((x: number) => x + 1)"))).toMatchObject({ carried: 2 });
});

// The census is sound when no way of making a receiver-reading function a
// member is missed. Each store below makes `label` the member `f` of
// `host` in a program of its own; the call of `host.f` must carry.
const READER = [
  "type F = () => string;",
  "interface Holder { name: string; f: F }",
  'function label(this: unknown): string { return this === undefined ? "none" : "holder"; }',
  "function id<T>(x: T): T { return x; }",
];
const UNKNOWN_KEY = 'const key: string = process.argv.length > 100 ? "other" : "f";';
const SOURCE = "const source = { callback: label as F };";
const STORES: Record<string, string[]> = {
  "a property": ['const host: Holder = { name: "h", f: label as F };'],
  "a function expression": [
    'const host: Holder = { name: "h", f: function (this: unknown): string { return this === undefined ? "none" : "holder"; } as F };',
  ],
  "a computed literal key": ['const host: Holder = { name: "h", ["f"]: label as F };'],
  "a computed constant key": [
    'const k = "f" as const;',
    'const host: Holder = { name: "h", [k]: label as F };',
  ],
  "a computed key that is not known": [
    UNKNOWN_KEY,
    "const table: Record<string, F> = { [key]: label as F };",
    'const host: Holder = { name: "h", f: table[key]! };',
  ],
  "an assignment under a key that is not known": [
    UNKNOWN_KEY,
    "const table: Record<string, F> = {};",
    "table[key] = label as F;",
    'const host: Holder = { name: "h", f: table.f! };',
  ],
  "a later assignment": [
    'const host: Holder = { name: "h", f: () => "arrow" };',
    "host.f = label as F;",
  ],
  "an assignment to an element": [
    'const host: Holder = { name: "h", f: () => "arrow" };',
    'host["f"] = label as F;',
  ],
  "a nullish assignment": [
    'const loose: { name: string; f?: F } = { name: "h" };',
    "loose.f ??= label as F;",
    "const host = loose as Holder;",
  ],
  "a destructuring target": [
    'const host: Holder = { name: "h", f: () => "arrow" };',
    "({ a: host.f } = { a: label as F });",
  ],
  "a shorthand": ["const f = label as F;", 'const host: Holder = { name: "h", f };'],
  "a variable": [
    'let g: F = () => "arrow";',
    "g = label as F;",
    'const host: Holder = { name: "h", f: g };',
  ],
  "a factory's parameter": [
    'function make(g: F): Holder { return { name: "h", f: g }; }',
    "const host = make(label as F);",
  ],
  "a factory's parameter after a declared this": [
    'function make(this: unknown, g: F): Holder { return { name: "h", f: g }; }',
    "const host = make(label as F);",
  ],
  "a factory's parameter after a spread": [
    'function make(n: number, g: F): Holder { return { name: "h" + n, f: g }; }',
    "const first: [number] = [1];",
    "const host = make(...first, label as F);",
  ],
  "a default parameter": [
    'function make(g: F = label as F): Holder { return { name: "h", f: g }; }',
    "const host = make();",
  ],
  "a destructured default": [
    'function make({ f = label as F }: { f?: F }): Holder { return { name: "h", f }; }',
    "const host = make({});",
  ],
  "a return value": [
    "function pick(): F { return label as F; }",
    'const host: Holder = { name: "h", f: pick() };',
  ],
  "a generic identity function": ['const host: Holder = { name: "h", f: id(label as F) };'],
  "a callback's parameter": [
    "function later(cb: (g: F) => void): void { cb(label as F); }",
    'let made: Holder = { name: "h", f: () => "arrow" };',
    'later((g) => { made = { name: "h", f: g }; });',
    "const host: Holder = made;",
  ],
  "an overriding method's parameter": [
    'class Base { take(g: F): Holder { return { name: "b", f: () => "arrow" }; } }',
    'class Derived extends Base { take(g: F): Holder { return { name: "d", f: g }; } }',
    "const maker: Base = new Derived();",
    "const host = maker.take(label as F);",
  ],
  "a member read by name": [SOURCE, 'const host: Holder = { name: "h", f: source.callback };'],
  "a member read by a string index": [
    SOURCE,
    'const host: Holder = { name: "h", f: source["callback"] };',
  ],
  "a destructured member": [
    SOURCE,
    "const { callback } = source;",
    'const host: Holder = { name: "h", f: callback };',
  ],
  "a renamed destructured member": [
    SOURCE,
    "const { callback: g } = source;",
    'const host: Holder = { name: "h", f: g };',
  ],
  "a member read passed on": [
    SOURCE,
    'function relay(g: F): Holder { return { name: "h", f: g }; }',
    "const host = relay(source.callback);",
  ],
  "an object-literal method read off its object": [
    'const source = { name: "s", m(): string { return this === undefined ? "none" : "holder"; } };',
    'const host: Holder = { name: "h", f: source.m };',
  ],
  "a member read under a key that is not known": [
    "const source: Record<string, F> = { a: label as F };",
    'let got: F = () => "arrow";',
    "for (const k in source) got = source[k]!;",
    'const host: Holder = { name: "h", f: got };',
  ],
  "Object.values": [
    "const source = { a: label as F };",
    'const host: Holder = { name: "h", f: Object.values(source)[0]! };',
  ],
  "an array and back": [
    "const fs: F[] = [label as F];",
    'const host: Holder = { name: "h", f: fs[0]! };',
  ],
  "a tuple and back": [
    'const pair: [string, F] = ["p", label as F];',
    'const host: Holder = { name: "h", f: pair[1] };',
  ],
  "a Map and back": [
    'const table = new Map<string, F>([["k", label as F]]);',
    'const host: Holder = { name: "h", f: table.get("k")! };',
  ],
  "an object spread": [
    "const base = { f: label as F };",
    'const host: Holder = { name: "h", ...base };',
  ],
  "Object.assign": ['const host: Holder = Object.assign({ name: "h" }, { f: label as F });'],
  "Object.fromEntries": [
    'const host = Object.fromEntries([["f", label as F]]) as Record<string, F> as { f: F };',
  ],
  "Reflect.set": [
    'const host: Holder = { name: "h", f: () => "arrow" };',
    'Reflect.set(host, "f", label);',
  ],
  "a conditional": [
    'const host: Holder = { name: "h", f: process.argv.length > 100 ? (): string => "arrow" : (label as F) };',
  ],
  "a logical or": [
    'const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;',
    'const host: Holder = { name: "h", f: none || (label as F) };',
  ],
};

async function carried(body: string[]): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-member-receiver-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const module = deserializeModule(await readFile(outPath, "utf8"));
    return recordsOf(module).filter(
      (node) =>
        (node["kind"] === "callValue" || node["kind"] === "dynCall") &&
        node["receiver"] !== undefined,
    ).length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [name, store] of Object.entries(STORES))
  test(`the member's call carries its holder when the function arrives through ${name}`, async () => {
    expect(await carried([...READER, ...store, "console.log(host.f());", ""])).toBeGreaterThan(0);
  });

test("a member read into a variable escapes; read only to be called or tested, it does not", async () => {
  const program = (use: string): string[] => [
    ...READER,
    'const host: Holder = { name: "h", f: label as F };',
    'function hold(g: F): { name: string; g: F } { return { name: "o", g }; }',
    'const other = hold(() => "arrow");',
    use,
    "console.log(host.f(), other.g());",
    "",
  ];
  // Only `f` carries while every read of `f` is a call or a test.
  expect(
    await carried(
      program('if (host.f !== undefined && typeof host.f === "function") console.log("f");'),
    ),
  ).toBe(1);
  // Read into a variable, a pattern or the standard library, it may be
  // anywhere a store cannot rule it out: `g`, stored from a parameter,
  // carries too.
  expect(await carried(program("const alias = host.f; alias();"))).toBe(2);
  expect(await carried(program("const { f } = host; f();"))).toBe(2);
  expect(await carried(program("console.log(Object.values(host).length);"))).toBe(2);
});

test("a member that only ever holds an arrow or a bound function does not carry", async () => {
  for (const value of ['() => "arrow"', '(label as F).bind({ name: "bound" })'])
    expect(
      await carried([
        ...READER,
        `const host: Holder = { name: "h", f: ${value} };`,
        "console.log(host.f(), label.call(host));",
        "",
      ]),
    ).toBe(0);
});

test("every spelling of a member call carries the holder", async () => {
  const count = await carried([
    ...READER,
    'const host: Holder = { name: "h", f: label as F };',
    "const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;",
    "interface Wide { name: string; n: number; f: F }",
    'const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];',
    "console.log(",
    '  host.f(), host["f"](), (host.f)(), (host.f as F)(), host.f!(),',
    '  maybe?.f?.(), maybe?.["f"]?.(), maybe?.f!(), both[0]!.f(), both[1]!["f"](),',
    ");",
    "",
  ]);
  expect(count).toBe(10);
});
