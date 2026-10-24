import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compile } from "../src/index.js";

// A package shaped like a validation library: schema classes with a virtual
// `_parse`, per-field context and result literals, a class holding the
// context, and an output object built with computed keys.
const packageSource = `
export class Status {
  constructor() { this.value = "valid"; }
  dirty() { if (this.value === "valid") this.value = "dirty"; }
}
class LazyPath {
  constructor(parent, data, key) { this.parent = parent; this.data = data; this.key = key; }
  get path() { return [this.key]; }
}
export class Base {
  constructor(def) { this._def = def; }
  ctxOf(input) { return { common: input.parent.common, data: input.data, parent: input.parent }; }
  parse(data) {
    const root = { common: { issues: [] }, data, parent: null };
    const result = this._parse({ data, parent: root });
    return result.value;
  }
}
export class Str extends Base {
  _parse(input) {
    const status = new Status();
    if (typeof input.data !== "string") status.dirty();
    return { status: status.value, value: input.data };
  }
}
export class Obj extends Base {
  _parse(input) {
    const ctx = this.ctxOf(input);
    const pairs = [];
    for (const key of Object.keys(this._def.shape)) {
      const field = this._def.shape[key];
      pairs.push({ key, value: field._parse(new LazyPath(ctx, ctx.data[key], key)) });
    }
    const out = {};
    for (const pair of pairs) out[pair.key] = pair.value.value;
    return { status: "valid", value: out };
  }
}
export const str = () => new Str({ checks: [] });
export const obj = (shape) => new Obj({ shape });
export function leak(value) { globalThis.leaked = value; return value; }
export function reflect() { const o = { a: 1 }; delete o.a; return o; }
class Box {}
function tag(strings, ...values) { leak(values[0]); return strings.raw.length; }
export function arrayProp() { const list = []; list.meta = { listed: 1 }; return leak(list.meta); }
export function computedField(k) {
  const box = new Box();
  box[k] = { boxed: 1 };
  Box[k] = { onClass: 1 };
  const fn = function () {};
  fn[k] = { onFunction: 1 };
  return [leak(box.held), leak(Box.held), leak(fn.held)];
}
export function revive(text) {
  const seen = { revived: 1 };
  return JSON.parse(text, function (k, v) { globalThis.revived = seen; return v; });
}
class Doc {
  constructor() { this.body = { doc: 1 }; }
  toJSON() { return leak(this.body); }
}
export function stringified() {
  const own = { owned: 1 };
  return [
    JSON.stringify({ inner: { replaced: 1 } }, (k, x) => leak(x)),
    JSON.stringify(new Doc()),
    JSON.stringify({ toJSON() { return leak(own); } }),
  ];
}
export function proxied() { return new Proxy({ proxied: 1 }, {}); }
export function reflectDelete() { const o = { gone: 1 }; Reflect.deleteProperty(o, "gone"); return o; }
export function tagged() { return tag\`a\${{ part: 1 }}b\`; }
`;

const packageTypes = `
export declare class Base { parse(data: unknown): unknown; }
export declare class Str extends Base {}
export declare class Obj extends Base {}
export declare const str: () => Str;
export declare const obj: (shape: Record<string, Base>) => Obj;
export declare function leak<T>(value: T): T;
export declare function reflect(): object;
export declare function arrayProp(): unknown;
export declare function computedField(k: string): unknown;
export declare function revive(text: string): unknown;
export declare function stringified(): unknown;
export declare function proxied(): unknown;
export declare function reflectDelete(): unknown;
export declare function tagged(): unknown;
`;

const mainSource = `
import {
  arrayProp,
  computedField,
  leak,
  obj,
  proxied,
  reflect,
  reflectDelete,
  revive,
  str,
  stringified,
  tagged,
} from "shapes-fixture";
const schema = obj({ a: str(), b: str() });
const input: unknown = JSON.parse('{"a":"x","b":"y"}');
console.log(JSON.stringify(schema.parse(input)));
console.log(JSON.stringify(leak({ kept: 1 })), JSON.stringify(reflect()));
const more = [
  arrayProp(),
  computedField("held"),
  revive("{}"),
  stringified(),
  proxied(),
  reflectDelete(),
  tagged(),
];
console.log(more.length);
`;

let dir: string;
let saved: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-shapes-"));
  const pkg = join(dir, "node_modules", "shapes-fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "shapes-fixture",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      types: "index.d.ts",
    }),
  );
  await writeFile(join(pkg, "index.js"), packageSource);
  await writeFile(join(pkg, "index.d.ts"), packageTypes);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "shapes-fixture": "1.0.0" } }),
  );
  await writeFile(join(dir, "main.ts"), mainSource);
  saved = process.env["SCRIPTC_DEBUG_SHAPES"];
});
afterEach(async () => {
  if (saved === undefined) delete process.env["SCRIPTC_DEBUG_SHAPES"];
  else process.env["SCRIPTC_DEBUG_SHAPES"] = saved;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function report(): Promise<string[]> {
  process.env["SCRIPTC_DEBUG_SHAPES"] = "verbose";
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const l of text.split("\n")) if (l.startsWith("[shapes] ")) lines.push(l.slice(9));
    return true;
  });
  const entry = join(dir, "main.ts");
  await compile(entry, {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["shapes-fixture"],
  });
  return lines;
}

function site(lines: string[], label: RegExp): string {
  const line = lines.find((l) => l.startsWith("site ") && label.test(l));
  if (line === undefined) throw new Error(`no site ${label}:\n${lines.join("\n")}`);
  return line;
}

test("S1 report: per-field temporaries are provable records, dynamic objects stay G", async () => {
  const lines = await report();
  // result literals of both _parse implementations, the pair literal, the
  // context and the root context never escape: native records would be exact
  // the leaf schema's result: in a function called from a loop (hot)
  expect(site(lines, /^site \{status,value\}@shapes-fixture\/index\.js:23 \[hot\]/)).toMatch(
    /: P-local/,
  );
  expect(site(lines, /^site \{status,value\}@shapes-fixture\/index\.js:36/)).toMatch(/: P-local/);
  expect(site(lines, /^site \{key,value\}@/)).toMatch(/: P-local/);
  expect(site(lines, /^site \{common,data,parent\}@shapes-fixture\/index\.js:12/)).toMatch(
    /: P-local/,
  );
  expect(site(lines, /^site \[\]@shapes-fixture\/index\.js:29/)).toMatch(/: P-local/);
  // the output object is built with computed keys
  expect(site(lines, /^site \{\}@shapes-fixture\/index\.js:34/)).toMatch(/: G — computed write/);
  // a deleted key and a value stored into the global object
  expect(site(lines, /^site \{a\}@/)).toMatch(/: G — delete at/);
  expect(site(lines, /^site \{kept\}@main\.ts/)).toMatch(/: P-escaping — escapes: stored into ⊤/);
  // receiver-typed dispatch: the field's validators are the schema classes
  expect(lines.find((l) => l.startsWith("fn Str._parse@"))).toMatch(/p0=LazyPath/);
  expect(lines.find((l) => l.startsWith("class LazyPath"))).toMatch(
    /parent: \{common,data,parent\}@shapes-fixture\/index\.js:12;/,
  );
  expect(lines.find((l) => l.startsWith("class Str"))).toMatch(/_def: \{checks\}@/);
});

test("S1 report follows values through array properties, unknown keys, callbacks and reflection", async () => {
  const lines = await report();
  // a named property of an array, read back and leaked
  expect(site(lines, /^site \{listed\}@/)).toMatch(/: P-escaping/);
  // computed writes to an instance, a class and a function, read by name
  expect(site(lines, /^site \{boxed\}@/)).toMatch(/: P-escaping/);
  expect(site(lines, /^site \{onClass\}@/)).toMatch(/: P-escaping/);
  expect(site(lines, /^site \{onFunction\}@/)).toMatch(/: P-escaping/);
  // a JSON.parse reviver, a JSON.stringify replacer, and toJSON methods
  expect(site(lines, /^site \{revived\}@/)).toMatch(/: P-escaping — escapes: stored into ⊤/);
  expect(site(lines, /^site \{replaced\}@/)).toMatch(/: P-escaping/);
  expect(site(lines, /^site \{doc\}@/)).toMatch(/: P-escaping/);
  expect(site(lines, /^site \{owned\}@/)).toMatch(/: P-escaping/);
  // a Proxy target and Reflect.deleteProperty
  expect(site(lines, /^site \{proxied\}@/)).toMatch(/: G — proxy at/);
  expect(site(lines, /^site \{gone\}@/)).toMatch(/: G — delete at/);
  // a tagged template's substitution, passed to its tag
  expect(site(lines, /^site \{part\}@/)).toMatch(/: P-escaping/);
  // the existing verdicts hold
  expect(site(lines, /^site \{kept\}@main\.ts/)).toMatch(/: P-escaping — escapes: stored into ⊤/);
});

test("S1 report is off by default and changes nothing", async () => {
  delete process.env["SCRIPTC_DEBUG_SHAPES"];
  const writes = vi.spyOn(process.stderr, "write");
  const entry = join(dir, "main.ts");
  await compile(entry, {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["shapes-fixture"],
  });
  expect(writes.mock.calls.some(([c]) => String(c).includes("[shapes]"))).toBe(false);
});
