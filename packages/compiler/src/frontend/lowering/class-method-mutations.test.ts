import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import type { IrModule } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";

/** The classes whose method calls `source` guards with a read of the
 * instance's property bag (a method the program may have replaced), with the
 * number of such reads. A class whose calls are all direct is absent. */
async function guardedClasses(
  source: string,
  files: Record<string, string> = {},
): Promise<Record<string, number>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-method-mutations-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod: IrModule = deserializeModule(await readFile(outPath, "utf8"));
    const guarded: Record<string, number> = {};
    for (const fn of mod.functions) {
      // The dispatch helpers themselves are not call sites.
      if (/^%(class|dyn|prototype)\./.test(fn.name)) continue;
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (e) => {
          if (e.kind === "call" && e.callee.startsWith("%class.readProperties:")) {
            const name = e.callee.slice(e.callee.lastIndexOf(":") + 1).replace(/^.*\./, "");
            guarded[name] = (guarded[name] ?? 0) + 1;
          }
          return true;
        },
      });
    }
    return guarded;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const classes = `
class Queue {
  private items: string[] = [];
  enqueue(item: string): void { this.items.push(item); }
  size(): number { return this.items.length; }
}
class Screen {
  title = "first";
  draw(): string { return "[" + this.title + "]"; }
}
`;
const calls = `
const queue = new Queue();
queue.enqueue("a");
const screen = new Screen();
console.log(queue.size(), screen.draw());
`;

test("without a write that could replace a method, every call is direct", async () => {
  expect(await guardedClasses(`${classes}${calls}`)).toEqual({});
});

test("an unknown key written through a class-typed receiver reaches only that class", async () => {
  const guarded = await guardedClasses(`${classes}
function forward(target: Screen, property: string, value: unknown): boolean {
  return Reflect.set(target, property, value, target);
}
${calls}
console.log(forward(screen, "title", "second"), screen.draw(), queue.size());
`);
  expect(Object.keys(guarded)).toEqual(["Screen"]);
});

test("an unknown key written through an interface reaches the classes with its members", async () => {
  const guarded = await guardedClasses(`${classes}
interface Titled { title: string; draw(): string }
function forward(target: Titled, property: string, value: unknown): void {
  (target as unknown as Record<string, unknown>)[property] = value;
}
${calls}
forward(screen, "title", "second");
console.log(screen.draw(), queue.size());
`);
  expect(Object.keys(guarded)).toEqual(["Screen"]);
});

test("Object.assign onto a record type no class has the members of guards nothing", async () => {
  expect(
    await guardedClasses(`${classes}
interface Options { depth: number; label: string }
function merge(options: Options, patch: Partial<Options>): Options {
  return Object.assign(options, patch);
}
${calls}
console.log(JSON.stringify(merge({ depth: 1, label: "a" }, { depth: 2 })));
`),
  ).toEqual({});
});

test("an unknown key written through an untyped receiver still reaches every class", async () => {
  const guarded = await guardedClasses(`${classes}
function forward(target: any, property: string, value: unknown): void {
  target[property] = value;
}
${calls}
forward(screen, "title", "second");
console.log(screen.draw(), queue.size());
`);
  expect(Object.keys(guarded).sort()).toEqual(["Queue", "Screen"]);
});

test("Reflect.set with a receiver argument other than its target reaches every class", async () => {
  const guarded = await guardedClasses(`${classes}
function forward(target: Screen, property: string, value: unknown, receiver: object): boolean {
  return Reflect.set(target, property, value, receiver);
}
${calls}
console.log(forward(screen, "title", "second", screen), screen.draw(), queue.size());
`);
  expect(Object.keys(guarded).sort()).toEqual(["Queue", "Screen"]);
});

test("an anonymous class is judged by the instances its constructor answers", async () => {
  const guarded = await guardedClasses(`${classes}
const Counter = class {
  count = 0;
  bump(): number { return ++this.count; }
};
interface Options { depth: number; label: string }
function merge(options: Options, patch: Partial<Options>): Options {
  return Object.assign(options, patch);
}
${calls}
const counter = new Counter();
console.log(counter.bump(), JSON.stringify(merge({ depth: 1, label: "a" }, { depth: 2 })));
`);
  expect(guarded).toEqual({});
});

test("a class in an unchecked JavaScript file keeps every unknown-key write global", async () => {
  // Its members are not declared, so no receiver type can exclude it.
  const guarded = await guardedClasses(
    `import { makeGauge } from "./gauge.js";
${classes}
interface Options { depth: number; label: string }
function merge(options: Options, patch: Partial<Options>): Options {
  return Object.assign(options, patch);
}
${calls}
console.log(makeGauge().read(), JSON.stringify(merge({ depth: 1, label: "a" }, { depth: 2 })));
`,
    {
      "gauge.js": `class Gauge { read() { return 1; } }
export function makeGauge() { return new Gauge(); }
`,
    },
  );
  expect(Object.keys(guarded).sort()).toEqual(["Queue", "Screen"]);
});
