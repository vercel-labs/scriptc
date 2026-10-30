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

test("a data-only anonymous type keeps the native width copy", async () => {
  const kinds = await globalKinds(`
class Point { x = 1; y = 2; }
const point = new Point();
const copy: { x: number; y: number } = point;
console.log(copy.x + copy.y);
`);
  expect(kinds["copy"]).toBe("record");
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
