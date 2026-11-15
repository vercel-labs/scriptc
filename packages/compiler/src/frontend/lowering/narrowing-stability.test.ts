import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../../index.js";
import type { IrModule } from "../../ir/ir.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-narrowing-stability-"));
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

/** The TypeError messages a function's checked reads can throw. */
function thrownMessages(module: IrModule, name: string): string[] {
  const fn = module.functions.find((f) => f.name === name || f.name.endsWith(`.${name}`));
  if (!fn) throw new Error(`no function ${name}`);
  const messages: string[] = [];
  JSON.stringify(fn.body, (_key, value: unknown) => {
    const node = value as { kind?: string; fn?: string; args?: { value?: unknown }[] };
    if (node?.kind === "libCall" && node.fn === "error.nodeThrow")
      messages.push(String(node.args?.[2]?.value));
    return value;
  });
  return messages;
}

const SOURCE = `
class Tree {
  parent: Tree | undefined;
  depth: number;
  constructor(parent: Tree | undefined) {
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
  }
}
class Box {
  label: string | undefined = undefined;
  clear(): void { this.label = undefined; }
}
function visit(t: Tree): number { return t.depth; }
function constructionOnly(t: Tree): number {
  if (t.parent) {
    visit(t);
    return t.parent.depth;
  }
  return -1;
}
function noCall(b: Box): number {
  if (b.label !== undefined) return b.label.length + b.label.length;
  return 0;
}
function libraryCalls(b: Box, xs: number[]): number {
  if (b.label !== undefined) {
    xs.push(Math.max(1, 2));
    console.log("x");
    return b.label.length;
  }
  return 0;
}
function userCall(b: Box): number {
  if (b.label !== undefined) {
    visit(new Tree(undefined));
    return b.label.length;
  }
  return 0;
}
function methodCall(b: Box): number {
  if (b.label !== undefined) {
    b.clear();
    return b.label.length;
  }
  return 0;
}
function loopBackEdge(b: Box): number {
  let n = 0;
  if (b.label !== undefined) {
    for (let i = 0; i < 2; i++) {
      n += b.label.length;
      b.clear();
    }
  }
  return n;
}
const b = new Box();
b.label = "abc";
console.log(constructionOnly(new Tree(new Tree(undefined))), noCall(b), libraryCalls(b, []),
  userCall(b), methodCall(b), loopBackEdge(b));
`;

test("narrowed reads keep the unchecked extraction where nothing can change the field", async () => {
  const module = await lower(SOURCE);
  expect(thrownMessages(module, "constructionOnly")).toEqual([]);
  expect(thrownMessages(module, "noCall")).toEqual([]);
  expect(thrownMessages(module, "libraryCalls")).toEqual([]);
});

test("narrowed reads after code that can clear the field check it with Node's TypeError", async () => {
  const module = await lower(SOURCE);
  const read = "Cannot read properties of undefined (reading 'length')";
  expect(thrownMessages(module, "userCall")).toContain(read);
  expect(thrownMessages(module, "methodCall")).toContain(read);
  expect(thrownMessages(module, "loopBackEdge")).toContain(read);
});

test("standard-library arguments read as declared only where the lowering is generic", async () => {
  // JSON.stringify and clearInterval lower only the narrowed argument types;
  // console methods and type-parameter slots take the declared value.
  const module = await lower(`
interface Opts {
  p?: { [k: string]: number };
}
function touch(): number {
  return 1;
}
let handle: ReturnType<typeof setInterval> | null = null;
const stop = (): void => {
  handle = null;
};
function specialized(o: Opts): string {
  o.p = { a: 1 };
  touch();
  return JSON.stringify(o.p);
}
function clearAfterCall(): void {
  if (handle !== null) {
    touch();
    clearInterval(handle);
  }
}
function formatted(o: Opts, out: (Opts["p"])[]): void {
  o.p = { a: 2 };
  touch();
  console.log(o.p);
  out.push(o.p);
}
handle = setInterval(() => {}, 1000);
console.log(specialized({}));
clearAfterCall();
stop();
formatted({}, []);
`);
  expect(thrownMessages(module, "formatted")).toEqual([]);
});

/** Whether a function's body reads a binding whose id `matches`. */
function reads(module: IrModule, fn: string, matches: (id: string) => boolean): boolean {
  const found = module.functions.find((f) => f.name === fn || f.name.endsWith(`.${fn}`));
  if (!found) throw new Error(`no function ${fn}`);
  let seen = false;
  JSON.stringify(found.body, (_key, value: unknown) => {
    const node = value as { kind?: string; localId?: string };
    if (node?.kind === "varRef" && node.localId !== undefined && matches(node.localId)) seen = true;
    return value;
  });
  return seen;
}

/** Whether a function's body reads the module-level binding `name`. */
function readsGlobal(module: IrModule, fn: string, name: string): boolean {
  return reads(module, fn, (id) => id.endsWith(`.${name}`));
}

/** Whether a function's body reads its local `name`. */
function readsLocal(module: IrModule, fn: string, name: string): boolean {
  return reads(module, fn, (id) => id.startsWith(`${name}.`));
}

test("a narrowing to undefined that a call may have undone reads the stored value", async () => {
  // TypeScript types `start` as `undefined` at both slices. In `stale` the
  // closure ran since, so the argument is the binding; in `current` nothing
  // ran since the assignment, so the argument is absent.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale(): string {
  start = undefined;
  set();
  return "abcd".slice(start);
}
function current(): string {
  start = undefined;
  return "abcd".slice(start);
}
console.log(stale(), current());
`);
  expect(readsGlobal(module, "stale", "start")).toBe(true);
  expect(readsGlobal(module, "current", "start")).toBe(false);
});

test("a binding typed by flow alone reads as declared once another function may have assigned it", async () => {
  // `let text;` is `undefined` to the checker until this function assigns it.
  const module = await lower(`
let text;
let other;
function assign(): void {
  text = "t";
  other = "o";
}
console.log("x".padStart(3, other));
assign();
console.log("x".padStart(3, text));
`);
  const init = module.functions.find((f) => f.name.startsWith("%init"))!.name;
  expect(readsGlobal(module, init, "text")).toBe(true);
  expect(readsGlobal(module, init, "other")).toBe(false);
});

test("an untyped binding initialized from such a read holds the stored value", async () => {
  // The checker infers `copy: undefined` from the narrowing of `start`.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale(): string {
  start = undefined;
  set();
  const copy = start;
  return "abcd".slice(copy);
}
console.log(stale());
`);
  expect(readsLocal(module, "stale", "copy")).toBe(true);
});

test("an assignment of the copy's own ends what its initializer left in it", async () => {
  const source = (reset: string): string => `
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function copied(clear: boolean) {
  start = undefined;
  set();
  let copy = start;
  ${reset}
  return copy;
}
copied(true);
`;
  // Every path to the return stores undefined last: the copy is undefined
  // there, and the function returns nothing, as the checker infers.
  for (const reset of [
    "copy = undefined;",
    "if (clear) copy = start; copy = undefined;",
    "if (clear) { copy = undefined; } else { copy = undefined; }",
    "for (let i = 0; i < 2; i++) { copy = start; } copy = undefined;",
    "try { copy = start; } finally { set(); } copy = undefined;",
  ])
    await lower(source(reset));
  // Some path keeps the initializer's value, or stores the read again.
  const refusal = /SC1090: returning 'copy' from a function whose return type TypeScript infers/;
  for (const reset of [
    "",
    "if (clear) copy = undefined;",
    "copy = undefined; copy = start;",
    "clear && (copy = undefined);",
    "clear || (copy = undefined);",
    "clear ? (copy = undefined) : 0;",
    "for (let i = 0; i < 1; i++) { if (clear) break; copy = undefined; }",
    "while (clear) { copy = undefined; break; }",
    "try { if (clear) throw new Error(); copy = undefined; } catch {}",
    "try { set(); } catch { copy = undefined; }",
    "block: { if (clear) break block; copy = undefined; }",
    "switch (clear) { case true: copy = undefined; }",
    "copy = undefined; if (clear) copy = start;",
  ])
    await expect(lower(source(reset)), reset).rejects.toThrow(refusal);
});

test("a function inferred to return undefined from a stale narrowing is refused", async () => {
  const source = (returnType: string): string => `
let found: string | undefined = undefined;
function search(): void {
  found = "hit";
}
function result()${returnType} {
  found = undefined;
  search();
  return found;
}
console.log(result());
`;
  await expect(lower(source(""))).rejects.toThrow(
    /SC1090: returning 'found' from a function whose return type TypeScript infers as 'undefined'/,
  );
  const module = await lower(source(": string | undefined"));
  expect(readsGlobal(module, "result", "found")).toBe(true);
});

/** The value a function's `return` statement carries: `"absent"` for a
 * bare return, `"present"` otherwise. */
function returnValue(module: IrModule, fn: string): string {
  const found = module.functions.find((f) => f.name === fn || f.name.endsWith(`.${fn}`));
  if (!found) throw new Error(`no function ${fn}`);
  let value = "none";
  JSON.stringify(found.body, (_key, node: unknown) => {
    const stmt = node as { kind?: string; value?: unknown };
    if (stmt?.kind === "return") value = stmt.value === null ? "absent" : "present";
    return node;
  });
  return value;
}

test("an untyped copy the function resets to undefined reads as absent", async () => {
  // The checker infers `copy: undefined` from the narrowing of `start`, but
  // `copy = undefined` is the write the return sees: there is nothing stale
  // left to carry, so the return is absent rather than refused.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale() {
  start = undefined;
  set();
  let copy = start;
  copy = undefined;
  return copy;
}
stale();
`);
  expect(returnValue(module, "stale")).toBe("absent");
});

test("a conditional assignment before the copy's reset does not reach its return", async () => {
  // `if (flag) copy = start` may not run, and `copy = undefined` after it
  // overwrites it when it does: the return still holds nothing.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
let flag = true;
function stale() {
  start = undefined;
  set();
  let copy = start;
  if (flag) copy = start;
  copy = undefined;
  return copy;
}
stale();
`);
  expect(returnValue(module, "stale")).toBe("absent");
});

test("a reset in the right operand of a logical operator does not end the copy's type", async () => {
  // `flag && (...)`: the reset may be skipped, so the copy may still hold the
  // stored value and the optional argument reads it.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
let flag = true;
function stale(): string {
  start = undefined;
  set();
  let copy = start;
  flag && (copy = undefined);
  return "abcd".slice(copy);
}
console.log(stale());
`);
  expect(readsLocal(module, "stale", "copy")).toBe(true);
});

test("an uninitialized var declaration in a loop does not reset the copy on later iterations", async () => {
  // A `var` binding is initialized when the function is entered, not each
  // time its declaration statement runs: on the second iteration the copy
  // still holds the value the first one stored, so the argument reads it.
  const loop = (declaration: string): string => `
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale(): string {
  start = undefined;
  set();
  for (let i = 0; i < 2; i++) {
    ${declaration}
    if (i === 1) return "abcd".slice(copy);
    copy = start;
  }
  return "none";
}
console.log(stale());
`;
  const stored = await lower(loop("var copy;"));
  expect(readsLocal(stored, "stale", "copy")).toBe(true);
  // A block-scoped declaration does initialize its binding each time.
  const fresh = await lower(loop("let copy;"));
  expect(readsLocal(fresh, "stale", "copy")).toBe(false);
});

test("a copy written from itself in a conditional keeps the type it held before the write", async () => {
  // `keep ? copy : undefined` stores the value `copy` already held when
  // `keep` is true, so the argument still reads the binding.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
let keep = true;
function stale(): string {
  start = undefined;
  set();
  let copy = start;
  copy = keep ? copy : undefined;
  return "abcd".slice(copy);
}
console.log(stale());
`);
  expect(readsLocal(module, "stale", "copy")).toBe(true);
});

test("an untyped copy assigned the stale read again after a reset is refused", async () => {
  await expect(
    lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale() {
  start = undefined;
  set();
  let copy = start;
  copy = undefined;
  copy = start;
  return copy;
}
stale();
`),
  ).rejects.toThrow(/SC1090: returning 'copy'/);
});

test("a copy assigned from itself under a condition still holds the stored value", async () => {
  // `copy = keep ? copy : undefined` is typed undefined on both arms, and
  // one of them is the copy: the write cannot be judged apart from the
  // value it reads, so the optional argument reads the copy.
  const module = await lower(`
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale(keep: boolean): string {
  start = undefined;
  set();
  let copy = start;
  copy = keep ? copy : undefined;
  return "abcd".slice(copy);
}
console.log(stale(true), stale(false));
`);
  expect(readsLocal(module, "stale", "copy")).toBe(true);
});

test("a var declared without a value in a loop keeps what an earlier iteration stored", async () => {
  // `var copy;` stores nothing when it runs: on the second iteration the
  // copy holds the first one's value. A `let` is a fresh undefined.
  const source = (declaration: string): string => `
let start: number | undefined = undefined;
const set = (): void => {
  start = 2;
};
function stale(): string {
  start = undefined;
  set();
  let out = "";
  for (let i = 0; i < 2; i++) {
    ${declaration}
    out += "abcd".slice(copy);
    copy = start;
  }
  return out;
}
console.log(stale());
`;
  expect(readsLocal(await lower(source("var copy;")), "stale", "copy")).toBe(true);
  expect(readsLocal(await lower(source("let copy;")), "stale", "copy")).toBe(false);
});

test("a binding initialized from `read && other` holds what the right operand answers", async () => {
  // The checker types `seen && fresh()` as `null` (it has `seen` narrowed
  // to its initializer), and `both` with it. The stored value is read, so
  // the pair answers `fresh()` once the closure has run, and the binding
  // is untyped: no checker type says what it holds.
  const source = (pair: string): string => `
function fresh(): boolean | undefined {
  return true;
}
function stale(): string {
  let seen: { n: number } | null = null;
  const mark = (): void => {
    seen = { n: 3 };
  };
  mark();
  const both = ${pair};
  return both ? "both" : "not both";
}
console.log(stale());
`;
  // The local holds the pair's own type (the binding's units and the right
  // operand's values), not the `null` the checker inferred for it.
  const holdsBoolean = (module: IrModule): boolean => {
    const stale = module.functions.find((f) => f.name === "stale" || f.name.endsWith(".stale"))!;
    const type = stale.locals.find((item) => item.name === "both")!.type;
    if (type.kind === "dyn") return true;
    if (type.kind !== "union") return false;
    const arms = (module.unions ?? []).find((u) => u.id === type.unionId)?.arms ?? [];
    return arms.some((arm) => arm.kind === "bool") && arms.some((arm) => arm.kind === "nullT");
  };
  expect(holdsBoolean(await lower(source("seen && fresh()")))).toBe(true);
  // A longer chain as well.
  expect(holdsBoolean(await lower(source("seen && fresh() && fresh()")))).toBe(true);
  // `read || other` and `read ?? other` keep their refusal: the binding's
  // checker type there is the right operand's, which the read does not fit.
  await expect(lower(source("seen || fresh()"))).rejects.toThrow(/SC2003|SC1090/);
  await expect(lower(source("seen ?? fresh()"))).rejects.toThrow(/SC2003|SC1090/);
});

test("`read && other` over a binding nothing else assigns keeps the checker's type", async () => {
  // Nothing can have assigned `seen` between its initializer and the read:
  // the narrowing holds, the pair is `null`, and a right operand of
  // another type has no place in it.
  await expect(
    lower(`
function fresh(): boolean | undefined {
  return true;
}
function current(): string {
  let seen: { n: number } | null = null;
  const both = seen && fresh();
  return both ? "both" : "not both";
}
console.log(current());
`),
  ).rejects.toThrow(/SC2003/);
});
