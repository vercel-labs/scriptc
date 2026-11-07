import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { lowerToIr } from "../src/frontend/lowering/lowerer.js";
import { loadProgram } from "../src/frontend/program-node.js";

// Which async-iteration protocol types hold a checked-dynamic value
// (frontend/lowering/async-protocol-holders.ts), read off the parameter
// types the lowering gives the functions that take them.

const PRELUDE = `
async function* numbers(): AsyncGenerator<number, void, unknown> { yield 1; }
async function* texts(): AsyncGenerator<string, void, unknown> { yield "a"; }
class Words implements AsyncIterable<string> {
  async *[Symbol.asyncIterator](): AsyncIterator<string> { yield "w"; }
}
async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const n of source) total += n;
  return total;
}
async function join(source: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const word of source) text += word;
  return text;
}
`;

let directory: string;
let next = 0;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-async-protocol-holders-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** The IR kind of each named function's first parameter, and the program's
 * diagnostics. */
function lower(
  body: string,
  names: readonly string[],
): { kinds: Record<string, string | undefined>; codes: string[] } {
  const file = join(directory, `case-${next++}.ts`);
  writeFileSync(file, PRELUDE + body);
  const load = loadProgram(file);
  try {
    const result = lowerToIr(load.program, load.entry, load.moduleOrder, {
      frontendServices: load.services,
    });
    const kinds: Record<string, string | undefined> = {};
    for (const name of names)
      kinds[name] = result.module?.functions.find((fn) => fn.name === name)?.params[0]?.type.kind;
    return { kinds, codes: result.diagnostics.map((d) => d.code) };
  } finally {
    load.dispose();
  }
}

test("only compiled generators: every protocol slot is a generator slot", () => {
  const { kinds, codes } = lower(
    `sum(numbers()).then(console.log);\njoin(texts()).then(console.log);\n`,
    ["sum", "join"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ sum: "generator", join: "generator" });
});

test("an implementor marks its element type and leaves the others", () => {
  const { kinds, codes } = lower(
    `sum(numbers()).then(console.log);\njoin(new Words()).then(console.log);\n`,
    ["sum", "join"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ sum: "generator", join: "dyn" });
});

test("the three interfaces over one element type share the answer", () => {
  const { kinds, codes } = lower(
    `
async function first(source: AsyncIterator<string>): Promise<string> {
  const step = await source.next();
  return step.done === true ? "" : step.value;
}
async function both(source: AsyncIterableIterator<string>): Promise<string> {
  let text = "";
  for await (const word of source) text += word;
  return text;
}
join(new Words()).then(console.log);
first(texts()).then(console.log);
both(texts()).then(console.log);
sum(numbers()).then(console.log);
`,
    ["join", "first", "both", "sum"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ join: "dyn", first: "dyn", both: "dyn", sum: "generator" });
});

test("a typed initializer, a return and a union arm are flow sites", () => {
  const { kinds, codes } = lower(
    `
const literal: AsyncIterable<boolean> = {
  [Symbol.asyncIterator]() {
    return { next: () => Promise.resolve({ value: undefined as any, done: true }) };
  },
};
async function flags(source: AsyncIterable<boolean>): Promise<number> {
  let count = 0;
  for await (const flag of source) if (flag) count++;
  return count;
}
function open(): AsyncIterable<string> | undefined {
  return new Words();
}
async function maybe(source: AsyncIterable<string> | undefined): Promise<string> {
  return source === undefined ? "" : join(source);
}
flags(literal).then(console.log);
maybe(open()).then(console.log);
sum(numbers()).then(console.log);
`,
    ["flags", "join", "sum"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ flags: "dyn", join: "dyn", sum: "generator" });
});

test("an untyped value marks the slot it enters", () => {
  const { kinds, codes } = lower(
    `
const anything: any = new Words();
join(anything).then(console.log);
sum(numbers()).then(console.log);
`,
    ["join", "sum"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ join: "dyn", sum: "generator" });
});

test("a marked protocol type marks the protocol type it flows into", () => {
  const { kinds, codes } = lower(
    `
type Text = string | number;
async function show(source: AsyncIterable<Text>): Promise<string> {
  let text = "";
  for await (const part of source) text += String(part);
  return text;
}
const words: AsyncIterable<string> = new Words();
show(words).then(console.log);
sum(numbers()).then(console.log);
`,
    ["show", "sum"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ show: "dyn", sum: "generator" });
});

test("an element type that names a type parameter follows the marked ones", () => {
  const { kinds, codes } = lower(
    `
class Gaps implements AsyncIterable<string | null> {
  async *[Symbol.asyncIterator](): AsyncIterator<string | null> { yield "g"; yield null; }
}
async function present<T>(source: AsyncIterable<T | null>): Promise<number> {
  let count = 0;
  for await (const item of source) if (item !== null) count++;
  return count;
}
present(new Gaps()).then(console.log);
sum(numbers()).then(console.log);
`,
    ["sum"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ sum: "generator" });
});

test("a generic function forwarding a marked type marks the slot it forwards into", () => {
  const { kinds, codes } = lower(
    `
async function count(source: AsyncIterable<unknown>): Promise<number> {
  let total = 0;
  for await (const _ of source) total++;
  return total;
}
function forward<T>(source: AsyncIterable<T>): Promise<number> {
  return count(source);
}
forward(new Words()).then(console.log);
sum(numbers()).then(console.log);
`,
    ["count", "sum"],
  );
  expect(codes).toEqual([]);
  expect(kinds).toEqual({ count: "dyn", sum: "generator" });
});
