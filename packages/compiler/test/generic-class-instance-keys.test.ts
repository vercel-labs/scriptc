import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-generic-keys-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return "";
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    return child.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a generic class with an Array<S> member is one instantiation inside a generic function's closure", async () => {
  // `interface Array<T>` holds a conditional type (`flat`) that does not
  // depend on `T`: the class is keyed by its arguments' layouts, so the
  // `List<S>` of `make<number>`, the one of `Cell<number>` and the
  // `List<number>` written out are one class.
  const stdout = await run(`
class List<S> {
  items: Array<S> | null = null;
  add(v: S): void {
    const l = this.items;
    if (l === null) this.items = [v];
    else l.push(v);
  }
  count(): number {
    const l = this.items;
    return l === null ? 0 : l.length;
  }
}
class Cell<S> {
  value: S;
  list: List<S> | null = null;
  constructor(v: S) { this.value = v; }
}
function make<S>(v: S): [Cell<S>, (a: S) => void] {
  const cell = new Cell<S>(v);
  return [cell, (a: S): void => {
    let l = cell.list;
    if (l === null) {
      l = new List<S>();
      cell.list = l;
    }
    l.add(a);
  }];
}
const [cell, dispatch] = make<number>(1);
dispatch(2);
dispatch(3);
const written: List<number> | null = cell.list;
const [text, dispatchText] = make<string>("a");
dispatchText("b");
console.log(cell.value, written === null ? -1 : written.count(), text.list === null ? -1 : text.list.count());
`);
  expect(stdout).toBe("1 2 1\n");
});

test("`this` in a class keyed by one literal argument of two is the class's own instantiation", async () => {
  const stdout = await run(`
type Flag<B extends boolean> = B extends true ? "on" : "off";
class Tagged<T, B extends boolean> {
  item: T;
  state: B;
  constructor(item: T, state: B) { this.item = item; this.state = state; }
  label(): Flag<B> { return (this.state ? "on" : "off") as Flag<B>; }
  describe(): string { return String(this.item) + ":" + this.label(); }
}
console.log(new Tagged(1, true).describe(), new Tagged("x", false).describe(), new Tagged(2, false).label());
`);
  expect(stdout).toBe("1:on x:off off\n");
});

test("a class is keyed by a literal argument that reaches a conditional through a parameter's default", async () => {
  // `Slot<T>` leaves `K` out, so `K` is `T`: the argument picks the
  // conditional's branch, and `Shelf<"wide">` and `Shelf<"thin">` are two
  // classes although both arguments have the layout of a string.
  const stdout = await run(`
type Slot<T, K = T> = K extends "wide" ? number : string;
type MaybeSlot<T> = Slot<T> | undefined;
class Shelf<T> {
  held: Slot<T>;
  spare: MaybeSlot<T>;
  constructor(v: Slot<T>) { this.held = v; this.spare = v; }
  get(): Slot<T> { return this.held; }
}
const wide = new Shelf<"wide">(41);
const thin = new Shelf<"thin">("reed");
console.log(typeof wide.get(), wide.get() + 1, typeof thin.get(), thin.get().length, typeof thin.spare);
`);
  expect(stdout).toBe("number 42 string 4 string\n");
});
