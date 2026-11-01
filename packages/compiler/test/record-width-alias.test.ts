import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** Compiles `source` to IR; the IR text and the diagnostics' codes. */
async function compileSource(
  source: string,
): Promise<{ ok: boolean; ir: string; codes: string[]; messages: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-record-width-alias-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.irc");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    const diagnostics = result.ok ? [] : result.diagnostics;
    return {
      ok: result.ok,
      ir: result.ok ? await readFile(outPath, "utf8") : "",
      codes: diagnostics.map((d) => d.code),
      messages: diagnostics.map((d) => `${d.code}: ${d.message}`),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALUE = `type Value = { value: number };
type Box = { next: Value | undefined; count: number };
`;

test("an annotated const keeps the value's layout when the fields fit it", async () => {
  const { ok, ir, messages } =
    await compileSource(`${VALUE}function open(next: any): [number, number] {
  const value = { next, count: 0 };
  const alias: Box = value;
  alias.next = { value: 42 };
  value.count++;
  return [alias.next.value, alias.count];
}
console.log(open(undefined).join(","));
export {};
`);
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
  // The annotation is the value's object, not a width copy of it.
  expect(ir).not.toContain("%rec.width");
});

test("an annotated let keeps it too", async () => {
  const { ok, ir, messages } =
    await compileSource(`${VALUE}function open(next: any): [number, number] {
  const value = { next, count: 0 };
  let alias: Box = value;
  alias.next = { value: 7 };
  value.count += 2;
  return [alias.next.value, alias.count];
}
console.log(open(undefined).join(","));
export {};
`);
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
  expect(ir).not.toContain("%rec.width");
});

test("a declared field wider than the value's field is refused when written through", async () => {
  const { messages } = await compileSource(`type Wide = { next: string | number; count: number };
function f(): string | number {
  const value = { next: "x", count: 0 };
  const alias: Wide = value;
  alias.next = 42;
  return alias.next;
}
console.log(f());
export {};
`);
  // The uses of `alias` inherit the declaration's blocker (SC2004), as
  // after any refused declaration.
  const refusal = messages.filter((m) => m.startsWith("SC2021"));
  expect(refusal).toHaveLength(1);
  expect(refusal[0]).toContain("the declared field 'next'");
  expect(refusal[0]).toContain("'string | number'");
  expect(refusal[0]).toContain("'string'");
});

test("a declaration the program does not write through still converts", async () => {
  const { ok, ir, messages } =
    await compileSource(`type Wide = { next: string | number; count: number };
const value = { next: "x", count: 0 };
const alias: Wide = value;
console.log(alias.next, value.count);
export {};
`);
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
  expect(ir).toContain("%rec.width");
});

test("a store of an existing array into a kept field is refused", async () => {
  const { messages } = await compileSource(`type Item = { list: number[] };
const source: number[] = [1, 2];
const value = { list: [0] as any[] };
const alias: Item = value;
alias.list = source;
source.push(3);
console.log(alias.list.length, alias.list[0], alias.list[2]);
export {};
`);
  // The kept `any[]` slot rebuilds the assigned `number[]`, so a later
  // push through `source` would not be seen through `alias.list`.
  const refusal = messages.filter((m) => m.startsWith("SC2021"));
  expect(refusal).toHaveLength(1);
  expect(refusal[0]).toContain("'alias.list'");
  // The kept slot is `any[]`, which the IR spells `unknown[]`.
  expect(refusal[0]).toContain("'unknown[]'");
  expect(refusal[0]).toContain("'number[]'");
});

test("reassigning an annotated let that kept its layout is refused", async () => {
  const { messages } = await compileSource(`type Item = { n: number; k: number };
function f(anyValue: any): void {
  const value = { n: anyValue, k: 1 };
  let alias: Item = value;
  const replacement: Item = { n: 2, k: 3 };
  alias = replacement;
  replacement.n = 9;
  console.log(alias.n, replacement.n);
}
f(1);
export {};
`);
  // `alias` keeps the initializer's `{ n: dyn; k: number }` layout, so the
  // assignment rebuilds `replacement` and the later write reaches only it.
  const refusal = messages.filter((m) => m.startsWith("SC2021"));
  expect(refusal).toHaveLength(1);
  expect(refusal[0]).toContain("'alias'");
  expect(refusal[0]).toContain("keeps the initializer's layout");
});

test("reassigning a kept let with a fresh literal still converts", async () => {
  const { ok, messages } = await compileSource(`type Item = { n: number; k: number };
function f(anyValue: any): void {
  const value = { n: anyValue, k: 1 };
  let alias: Item = value;
  alias = { n: 2, k: 3 };
  console.log(alias.n);
}
f(1);
export {};
`);
  // A fresh literal is built in the kept layout; there is no other name
  // holding the value, so no copy is observable.
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
});

test("a kept field the program mutates in place keeps its layout", async () => {
  const { ok, ir, messages } = await compileSource(`type Item = { list: number[] };
const value = { list: [0] as any[] };
const alias: Item = value;
alias.list.push(5);
console.log(alias.list.length, value.list.length);
export {};
`);
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
  // Only the initializer's own `[0]` widens to `any[]`; the push reads and
  // mutates the kept array, so it adds no copying call.
  expect(ir.match(/"callee":"%arr\.width/g)).toHaveLength(1);
});

test("a store of a value already in the kept layout still compiles", async () => {
  const { ok, messages } = await compileSource(`type Item = { list: number[] };
const value = { list: [0] as any[] };
const alias: Item = value;
const same = { list: [1] as any[] };
alias.list = same.list;
same.list.push(2);
console.log(alias.list.length);
export {};
`);
  // The stored value already has the kept `any[]` layout: no conversion,
  // and both names keep seeing the same array.
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
});

test("a parameter the callee writes is refused", async () => {
  const { messages } = await compileSource(`${VALUE}function bump(box: Box): void {
  box.count++;
}
const value = { next: undefined as any, count: 0 };
bump(value);
console.log(value.count);
export {};
`);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("SC2021");
  expect(messages[0]).toContain("the callee writes through 'box'");
});

test("a literal storing an existing value into a copied field is refused when written through", async () => {
  const { messages } = await compileSource(`type Inner = { a: number };
type WideInner = { a: number; b: number };
const wide: WideInner = { a: 1, b: 2 };
const holder: { inner: Inner } = { inner: wide };
holder.inner.a = 5;
console.log(wide.a);
export {};
`);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("SC2021");
  expect(messages[0]).toContain("'inner'");
});

test("a write in a function declared before the binding is refused", async () => {
  const { messages } = await compileSource(`type Wide = { next: string | number };
const value = { next: "x" };
function poke(): void {
  alias.next = 42;
}
const alias: Wide = value;
poke();
console.log(value.next);
export {};
`);
  expect(messages.filter((m) => m.startsWith("SC2021"))).toHaveLength(1);
});

test("an annotated array keeps its elements' optional reads", async () => {
  const { ok, ir, messages } = await compileSource(`const nums: number[] = [1, 2, 3];
const maybe: (number | undefined)[] = nums;
console.log(maybe[0], maybe.length);
export {};
`);
  expect(messages).toEqual([]);
  expect(ok).toBe(true);
  // `(T | undefined)[]` stores T elements, but its element reads are
  // optional (element-access.ts); the binding keeps the declared type, so
  // the optional-element mark stays in the IR.
  expect(ir).toContain("optionalElements");
});

test("a declaration that drops fields keeps converting", async () => {
  const { ok, ir, messages } = await compileSource(`type Narrow = { a: number };
const wide = { a: 1, b: 2 };
const narrow: Narrow = wide;
narrow.a = 5;
console.log(wide.a);
export {};
`);
  // A subset has no common storage with the source: the copy stays, and
  // the divergence is reported where divergences are (not refused here).
  expect(messages.filter((m) => m.includes("SC2021"))).toEqual([]);
  expect(ok).toBe(true);
  expect(ir).toContain("%rec.width");
});
