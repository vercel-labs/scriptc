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

test("once a receiver-reading function goes where it is not followed, an opaque store carries", async () => {
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
  // `onDone` is stored from a parameter; `onError` is always an arrow.
  expect(calls.carried).toBe(1);
});
