import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

async function lower(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-callback-emission-"));
  try {
    const entry = join(dir, "main.ts");
    const output = join(dir, "main.ir.json");
    writeFileSync(entry, source);
    const result = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("native callback fields and unchanged methods do not demand class reflection", async () => {
  const source = Array.from(
    { length: 12 },
    (_, i) => `
class Counter${i} {
  value = 0;
  notify(): void { this.value++; }
  callback = (n: number): number => this.value + n;
}
const counter${i} = new Counter${i}();
counter${i}.notify();
console.log(counter${i}.callback(${i}));
`,
  ).join("\n");
  const module = await lower(
    source +
      `
const values: Record<string, number> = {};
function key(): string { return "notify"; }
values[key()] = 1;
function update(values: Record<string, number>, name: string): void { values[name] = 2; }
update(values, key());
console.log(values[key()]);
`,
  );
  expect(module.functions.some((fn) => fn.name.startsWith("%dyn.class."))).toBe(false);
  const json = JSON.stringify(module.functions);
  expect(json).not.toContain('"kind":"dynCall"');
  expect(json).not.toContain('"kind":"dynFrom"');
  expect(json).toContain('"kind":"callValue"');
});

test("own-key rebuilding and absent-key insertion preserve inherited methods", async () => {
  const module = await lower(`
class Counter { value = 0; notify(): void { this.value++; } }
const counter = new Counter();
function rebuild(value: Record<string, unknown>): void {
  const entries = Object.entries(value);
  for (const key of Object.keys(value)) delete value[key];
  for (const [key, entry] of entries) if (!(key in value)) value[key] = entry;
}
const metadata: Record<string, unknown> = { label: "ready" };
rebuild(metadata);
counter.notify();
console.log(metadata.label, counter.value);
`);
  const initializers = module.functions.filter((fn) => fn.name.startsWith("%init."));
  expect(JSON.stringify(initializers)).toContain('"callee":"%Counter.notify"');
  expect(JSON.stringify(initializers)).not.toContain('"kind":"dynCall"');
});

test("observable method replacement keeps class property dispatch", async () => {
  const module = await lower(`
class Counter { value = 0; notify(): void { this.value++; } }
const counter = new Counter();
Object.defineProperty(counter, "notify", { value: (): void => { counter.value += 10; } });
counter.notify();
console.log(counter.value);
`);
  expect(module.functions.some((fn) => fn.name.startsWith("%dyn.class."))).toBe(true);
});
