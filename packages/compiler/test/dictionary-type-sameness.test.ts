import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The IR type kind of each named module-level binding. */
async function globalKinds(source: string): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dictionary-type-sameness-"));
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

/** A dictionary of `marked` values receives an existing record and is
 * written through, so it keeps checked identity. `probe` is a dictionary of
 * `other` values that receives nothing: it is checked-dynamic exactly when
 * `other` is the same type as `marked`. */
function program(types: string, marked: string, other: string, value: string): string {
  return `
${types}
const source = { first: ${value} };
const held: { [key: string]: ${marked} } = source;
held.second = ${value};
const probe: { [key: string]: ${other} } = {};
console.log(Object.keys(held).length, Object.keys(probe).length);
`;
}

interface Case {
  name: string;
  types?: string;
  marked: string;
  other: string;
  value: string;
  same: boolean;
}

const RECURSIVE = `
interface LinkA { next: { [key: string]: LinkA } | null; n: number }
interface LinkB { next: { [key: string]: LinkB } | null; n: number }
interface LinkC { next: { [key: string]: LinkC } | null; n: string }
interface Once { next: Once | null }
interface Twice { next: { next: Twice | null } | null }
`;

const CASES: Case[] = [
  {
    name: "a type literal spelled twice",
    marked: "{ n: number }",
    other: "{ n: number }",
    value: "{ n: 1 }",
    same: true,
  },
  {
    name: "an alias and its literal",
    types: "type V = { n: number };",
    marked: "V",
    other: "{ n: number }",
    value: "{ n: 1 }",
    same: true,
  },
  {
    name: "an interface and a literal",
    types: "interface V { n: number }",
    marked: "V",
    other: "{ n: number }",
    value: "{ n: 1 }",
    same: true,
  },
  {
    name: "a generic alias instantiation and a literal",
    types: "type Box<T> = { v: T };",
    marked: "Box<{ n: number }>",
    other: "{ v: { n: number } }",
    value: "{ v: { n: 1 } }",
    same: true,
  },
  {
    name: "a generic interface instantiation and a literal",
    types: "interface Box<T> { v: T }",
    marked: "Box<number>",
    other: "{ v: number }",
    value: "{ v: 1 }",
    same: true,
  },
  {
    name: "two instantiations of a generic interface",
    types: "interface Box<T> { v: T }",
    marked: "Box<{ n: number }>",
    other: "Box<{ n: number }>",
    value: "{ v: { n: 1 } }",
    same: true,
  },
  {
    name: "a readonly member",
    marked: "{ n: number }",
    other: "{ readonly n: number }",
    value: "{ n: 1 }",
    same: true,
  },
  {
    name: "a readonly index signature inside the value",
    marked: "{ [k: string]: number }",
    other: "{ readonly [name: string]: number }",
    value: "{ k: 1 }",
    same: true,
  },
  {
    name: "member order",
    marked: "{ a: number; b: string }",
    other: "{ b: string; a: number }",
    value: '{ a: 1, b: "b" }',
    same: true,
  },
  {
    name: "a union in another order",
    marked: "{ a: number } | { b: string }",
    other: "{ b: string } | { a: number }",
    value: "{ a: 1 }",
    same: true,
  },
  {
    name: "an intersection spelled twice",
    marked: "{ a: number } & { b?: string }",
    other: "{ a: number } & { b?: string }",
    value: "{ a: 1 }",
    same: true,
  },
  {
    name: "an array of a literal",
    marked: "{ n: number }[]",
    other: "{ n: number }[]",
    value: "[{ n: 1 }]",
    same: true,
  },
  {
    name: "a tuple of literals",
    marked: "[{ n: number }, string]",
    other: "[{ n: number }, string]",
    value: '[{ n: 1 }, "s"] as [{ n: number }, string]',
    same: true,
  },
  {
    name: "a Map of a literal",
    marked: "Map<string, { n: number }>",
    other: "Map<string, { n: number }>",
    value: "new Map<string, { n: number }>()",
    same: true,
  },
  {
    name: "a function type",
    marked: "(x: { n: number }) => { n: number }",
    other: "(value: { n: number }) => { n: number }",
    value: "(x: { n: number }) => x",
    same: true,
  },
  {
    name: "recursive interfaces of one structure",
    types: RECURSIVE,
    marked: "LinkA",
    other: "LinkB",
    value: "{ next: null, n: 1 }",
    same: true,
  },
  {
    name: "a recursive interface and its unrolling",
    types: RECURSIVE,
    marked: "Once",
    other: "Twice",
    value: "{ next: null }",
    same: true,
  },

  {
    name: "another member type",
    marked: "{ n: number }",
    other: "{ n: string }",
    value: "{ n: 1 }",
    same: false,
  },
  {
    name: "an optional member",
    marked: "{ n: number }",
    other: "{ n?: number }",
    value: "{ n: 1 }",
    same: false,
  },
  {
    name: "one more member",
    marked: "{ n: number }",
    other: "{ n: number; m?: string }",
    value: "{ n: 1 }",
    same: false,
  },
  {
    name: "another member name",
    marked: "{ n: number }",
    other: "{ m: number }",
    value: "{ n: 1 }",
    same: false,
  },
  {
    name: "a union with another member",
    marked: "{ a: number } | { b: string }",
    other: "{ a: number } | { b: number }",
    value: "{ a: 1 }",
    same: false,
  },
  {
    name: "a readonly array",
    marked: "{ n: number }[]",
    other: "readonly { n: number }[]",
    value: "[{ n: 1 }]",
    same: false,
  },
  {
    name: "an array of another element",
    marked: "{ n: number }[]",
    other: "{ n: string }[]",
    value: "[{ n: 1 }]",
    same: false,
  },
  {
    name: "a tuple of another arity",
    marked: "[{ n: number }, string]",
    other: "[{ n: number }]",
    value: '[{ n: 1 }, "s"] as [{ n: number }, string]',
    same: false,
  },
  {
    name: "a Map of another value",
    marked: "Map<string, { n: number }>",
    other: "Map<string, { n: string }>",
    value: "new Map<string, { n: number }>()",
    same: false,
  },
  {
    name: "a function of another result",
    marked: "(x: { n: number }) => { n: number }",
    other: "(x: { n: number }) => { n: string }",
    value: "(x: { n: number }) => x",
    same: false,
  },
  {
    name: "a function of another arity",
    marked: "(x: { n: number }) => void",
    other: "(x: { n: number }, y: number) => void",
    value: "(x: { n: number }) => { x.n += 1; }",
    same: false,
  },
  {
    name: "recursive interfaces that differ below",
    types: RECURSIVE,
    marked: "LinkA",
    other: "LinkC",
    value: "{ next: null, n: 1 }",
    same: false,
  },
  {
    name: "two classes of one structure",
    types: "class P { n = 1 }\nclass Q { n = 1 }",
    marked: "P",
    other: "Q",
    value: "new P()",
    same: false,
  },
  {
    name: "a primitive beside a literal",
    marked: "{ n: number }",
    other: "number",
    value: "{ n: 1 }",
    same: false,
  },
];

test.each(CASES)("dictionaries of $name: same type = $same", async (c) => {
  const kinds = await globalKinds(program(c.types ?? "", c.marked, c.other, c.value));
  expect(kinds["held"]).toBe("dyn");
  expect(kinds["probe"]).toBe(c.same ? "dyn" : "record");
});

test("a program that marks no dictionary keeps every spelling a native dictionary", async () => {
  // Nothing receives an existing object: no dictionary keeps identity, and
  // no type is compared.
  const kinds = await globalKinds(`
const first: { [key: string]: { n: number } } = {};
const second: { [key: string]: { n: number } } = { a: { n: 1 } };
first.b = { n: 2 };
console.log(Object.keys(first).length, Object.keys(second).length);
`);
  expect(kinds["first"]).toBe("record");
  expect(kinds["second"]).toBe("record");
});

test("the dictionary spellings of one value type are one type", async () => {
  const kinds = await globalKinds(`
type Dict<T> = { [key: string]: T };
type Alias = { [name: string]: { n: number } };
interface Declared { [key: string]: { n: number } }
const source = { first: { n: 1 } };
const held: { [key: string]: { n: number } } = source;
held.second = { n: 2 };
const generic: Dict<{ n: number }> = {};
const utility: Record<string, { n: number }> = {};
const alias: Alias = {};
const declared: Declared = {};
const frozen: Readonly<{ [key: string]: { n: number } }> = {};
const readonlySignature: { readonly [key: string]: { n: number } } = {};
const both: { [key: string]: { n: number } } & { [other: string]: { n: number } } = {};
const optional: { [key: string]: { n: number } } | undefined = {};
const numbers: { [key: string]: number } = {};
console.log(Object.keys(held).length, [generic, utility, alias, declared, frozen, readonlySignature, both, optional, numbers].length);
`);
  for (const name of [
    "held",
    "generic",
    "utility",
    "alias",
    "declared",
    "frozen",
    "readonlySignature",
    "both",
    "optional",
  ])
    expect(kinds[name], name).toBe("dyn");
  expect(kinds["numbers"]).toBe("record");
});
