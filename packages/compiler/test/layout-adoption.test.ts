import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The serialized IR of a program that must compile. */
async function irOf(
  source: string,
  tables?: string,
  modules: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-layout-adoption-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, `export {};\n${source}`);
    if (tables !== undefined) await writeFile(join(dir, "tables.ts"), tables);
    for (const [name, text] of Object.entries(modules)) await writeFile(join(dir, name), text);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The helpers a conversion between two record layouts is compiled to. */
const WIDTH_COPY = "%rec.width.";
const TUPLE_TO_ARRAY = "%tup.arr.";

const TOOL = `
interface Tool { readonly label: string; readonly grams?: number; readonly parts?: ReadonlyArray<Tool> }
function same(left: Tool, right: Tool): boolean { return left === right; }
`;

// A constant table read through one structural type, in a program that can
// tell a copy from the table, is built in that type's layout: no crossing
// converts it.
test.each([
  [
    "a flat table",
    `const awl = { label: "awl" } as const;
     console.log(same(awl, awl));`,
  ],
  [
    "a member the type makes optional, read through the table",
    `const awl = { grams: 40, label: "awl" } as const;
     console.log(same(awl, awl), awl.grams + 1, awl.label);`,
  ],
  [
    "nested literals, a list and another table by name",
    `const blade = { label: "blade" } as const;
     const plane = { label: "plane", parts: [blade, { label: "wedge", grams: 90 }] } as const;
     console.log(same(plane, plane), same(blade, blade));`,
  ],
  [
    "an annotated binding, a list element and an assertion",
    `const awl = { label: "awl" } as const;
     const held: Tool = awl;
     const rack: Tool[] = [awl];
     console.log(held === (awl as Tool), rack[0] === held);`,
  ],
  [
    "a nested literal and another table read through the table's own type",
    `const blade = { label: "blade" } as const;
     const plane = { label: "plane", best: blade, spare: { label: "wedge", grams: 90 } } as const;
     interface Kit { readonly label: string; readonly best?: Tool; readonly spare?: Tool }
     function whole(kit: Kit): boolean { return same(kit.best!, kit.spare!); }
     console.log(whole(plane), same(plane.best, plane.spare), plane.spare.grams + 1, plane.best === blade);`,
  ],
  [
    "members made elsewhere whose type is the slot's: a declared binding, a call's result",
    `interface Kit { readonly label: string; readonly best?: Tool; readonly spare?: Tool | null }
     function forge(label: string): Tool { return { label }; }
     function whole(kit: Kit): boolean { return kit === kit && kit.best === kit.spare; }
     const blade: Tool = { label: "blade" };
     const plane = { label: "plane", best: blade, spare: forge("wedge") } as const;
     console.log(whole(plane), same(plane.best, blade), plane.spare.label);`,
  ],
  [
    "a type parameter constrained to the type",
    `const awl = { label: "awl" } as const;
     function keep<Kind extends Tool>(tool: Kind): Tool { return tool; }
     console.log(keep(awl) === keep(awl));`,
  ],
])("%s takes the layout of the type it is read through", async (_name, body) => {
  const ir = await irOf(TOOL + body);
  expect(ir).not.toContain(WIDTH_COPY);
  expect(ir).not.toContain(TUPLE_TO_ARRAY);
});

// Everything else keeps its own layout and the conversion it had.
test.each([
  [
    "a program that never compares the type by identity",
    `interface Tool { readonly label: string; readonly grams?: number }
     function weigh(tool: Tool): number { return tool.grams ?? 0; }
     const awl = { label: "awl" } as const;
     console.log(weigh(awl));`,
  ],
  [
    "a table read through two structural types",
    `${TOOL}
     interface Priced { readonly label: string; readonly cents?: number }
     function price(item: Priced): number { return item.cents ?? 0; }
     const awl = { label: "awl" } as const;
     console.log(same(awl, awl), price(awl));`,
  ],
  [
    "a member the type does not declare",
    `${TOOL}
     const awl = { label: "awl", maker: "smith" } as const;
     console.log(same(awl, awl));`,
  ],
  [
    "a list read through the table's own type",
    `${TOOL}
     const plane = { label: "plane", parts: [{ label: "wedge" }] } as const;
     console.log(same(plane, plane), plane.parts.length);`,
  ],
  [
    "a nested literal that flows into a second type",
    `${TOOL}
     interface Kit { readonly label: string; readonly spare?: Tool }
     interface Weighed { readonly label: string; readonly grams: number }
     function heavy(tool: Weighed): boolean { return tool.grams > 50; }
     function kept(kit: Kit): boolean { return kit.spare === kit.spare; }
     const plane = { label: "plane", spare: { label: "wedge", grams: 90 } } as const;
     console.log(kept(plane), heavy(plane.spare));`,
  ],
  [
    "a table whose member table keeps its own layout, read through the table",
    `${TOOL}
     interface Kit { readonly label: string; readonly best?: Tool }
     interface Named { readonly label: string }
     function named(tool: Named): string { return tool.label; }
     function kept(kit: Kit): boolean { return kit.best === kit.best; }
     const blade = { label: "blade" } as const;
     const plane = { label: "plane", best: blade } as const;
     console.log(kept(plane), named(blade), same(blade, plane.best));`,
  ],
  [
    "a member made elsewhere in another layout than its slot's",
    `${TOOL}
     interface Kit { readonly label: string; readonly best?: Tool }
     function kept(kit: Kit): boolean { return kit.best === kit.best; }
     const blade = { label: "blade", maker: "smith" };
     const plane = { label: "plane", best: blade } as const;
     console.log(kept(plane), blade.maker);`,
  ],
  [
    "a generic callee that answers the table's own type",
    `${TOOL}
     function pass<Kind extends Tool>(tool: Kind): Kind { return tool; }
     const awl = { label: "awl" } as const;
     console.log(same(pass(awl), awl));`,
  ],
  [
    "a table held by a table that keeps its own layout",
    `${TOOL}
     const blade = { label: "blade" } as const;
     const kit = { label: "kit", parts: [blade], maker: "smith" } as const;
     console.log(same(blade, blade), same(kit, kit));`,
  ],
  [
    "a literal that is not constant",
    `${TOOL}
     const awl = { label: "awl" };
     console.log(same(awl, awl));`,
  ],
  [
    "a table in a function",
    `${TOOL}
     function make(): boolean {
       const awl = { label: "awl" } as const;
       return same(awl, awl);
     }
     console.log(make());`,
  ],
])("%s keeps its own layout", async (_name, source) => {
  expect(await irOf(source)).toContain(WIDTH_COPY);
});

// A module's tables behind a namespace import: the namespace names each
// export it is asked for, so its tables are followed like named imports. A
// namespace used as an object hands the module's tables to code that names
// none of them.
const SHED = `
export interface Tool { readonly label: string; readonly grams?: number }
export const awl = { label: "awl" } as const;
export function same(left: Tool, right: Tool): boolean { return left === right; }
`;

test("a table reached through a namespace import that is only asked for members takes the layout", async () => {
  const ir = await irOf(
    `import * as shed from "./tables.ts";
     console.log(shed.same(shed.awl, shed.awl), shed.awl.label);`,
    SHED,
  );
  expect(ir).not.toContain(WIDTH_COPY);
});

test.each([
  ["handed on", `console.log(shed.same(shed.awl, shed.awl), Object.keys(shed).length);`],
  [
    "destructured",
    `const { awl, same } = shed;
     console.log(same(awl, awl));`,
  ],
  [
    "read by a computed name",
    `const name: "awl" = "awl";
     console.log(shed.same(shed[name], shed.awl));`,
  ],
])("a table of a module whose namespace is %s keeps its own layout", async (_name, body) => {
  const ir = await irOf(`import * as shed from "./tables.ts";\n${body}`, SHED);
  expect(ir).toContain(WIDTH_COPY);
});

// A table is the same table under every name a module gives it: what an
// identifier stands for is the checker's symbol, never its spelling. The
// modules a table is renamed through, by the name of the test.
const RENAMES: Record<string, { modules: Record<string, string>; imports: string }> = {
  "an import under another name": {
    modules: {},
    imports: `import { awl as pick, same } from "./tables.ts";`,
  },
  "a re-export under another name": {
    modules: { "relay.ts": `export { awl as pick, same } from "./tables.ts";` },
    imports: `import { pick, same } from "./relay.ts";`,
  },
  "two re-exports, each under another name": {
    modules: {
      "relay.ts": `export { awl as spike } from "./tables.ts";`,
      "outlet.ts": `export { spike as point } from "./relay.ts";`,
    },
    imports: `import { point as pick } from "./outlet.ts";\nimport { same } from "./tables.ts";`,
  },
  "`export *`": {
    modules: { "relay.ts": `export * from "./tables.ts";` },
    imports: `import { awl as pick, same } from "./relay.ts";`,
  },
  "a default export": {
    modules: { "chosen.ts": `import { awl } from "./tables.ts";\nexport default awl;` },
    imports: `import pick from "./chosen.ts";\nimport { same } from "./tables.ts";`,
  },
  "an export named default": {
    modules: { "chosen.ts": `export { awl as default } from "./tables.ts";` },
    imports: `import { default as pick } from "./chosen.ts";\nimport { same } from "./tables.ts";`,
  },
};

test.each(Object.keys(RENAMES))("a table reached through %s takes the layout", async (name) => {
  const { modules, imports } = RENAMES[name]!;
  const ir = await irOf(`${imports}\nconsole.log(same(pick, pick), pick.label);`, SHED, modules);
  expect(ir).not.toContain(WIDTH_COPY);
});

/** Whether the tables of a program keep their own layouts: the program is
 * compiled with a width copy, or the copy is refused by name as it was
 * before. Never an internal error, and never the adopted layout. */
async function keepsLayout(
  source: string,
  tables: string,
  modules: Record<string, string> = {},
): Promise<boolean> {
  try {
    return (await irOf(source, tables, modules)).includes(WIDTH_COPY);
  } catch (error) {
    return /^(SC2002|SC2020|SC2021): /.test(error instanceof Error ? error.message : "");
  }
}

// The same names over a table whose list is read through the table's own
// type: a use the scan does not follow, under whatever name it is written.
// The table keeps its own layout and the program compiles as it did.
const RACK = `
export interface Tool { readonly label: string; readonly parts?: ReadonlyArray<Tool> }
export const awl = { label: "awl", parts: [{ label: "tip" }] } as const;
export const rack: Tool[] = [awl];
export function same(left: Tool, right: Tool): boolean { return rack.includes(left) && rack.includes(right); }
`;

test.each(Object.keys(RENAMES))(
  "a table whose list is read through %s keeps its own layout",
  async (name) => {
    const { modules, imports } = RENAMES[name]!;
    const kept = await keepsLayout(
      `${imports}\nconsole.log(same(pick, pick), pick.parts.length);\nfor (const part of pick.parts) console.log(part.label);`,
      RACK,
      modules,
    );
    expect(kept).toBe(true);
  },
);

// A binding declared from a table with no type of its own is another name
// of the table (or of the part a pattern names), followed like the table.
test.each([
  ["a `const` declared from it", `const pick = awl;\nconsole.log(same(pick, awl), pick.label);`],
  [
    "a chain of bindings",
    `const first = awl;\nlet pick = first;\nconsole.log(same(pick, first), pick.label);`,
  ],
  [
    "a binding inside a function",
    `function show(): void {\n  const pick = awl;\n  console.log(same(pick, awl), pick.label);\n}\nshow();`,
  ],
  ["a pattern over its members", `const { label } = awl;\nconsole.log(same(awl, awl), label);`],
])("a table named again by %s takes the layout", async (_name, body) => {
  const ir = await irOf(`import { awl, same } from "./tables.ts";\n${body}`, SHED);
  expect(ir).not.toContain(WIDTH_COPY);
});

test.each([
  ["reads its list", `const pick = awl;\nconsole.log(same(pick, awl), pick.parts.length);`],
  ["is exported", `export const pick = awl;\nconsole.log(same(pick, awl), pick.label);`],
  ["is spread", `const pick = awl;\nconsole.log(same(pick, awl), { ...pick }.label);`],
  ["binds its list", `const { parts } = awl;\nconsole.log(same(awl, awl), parts.length);`],
  [
    "binds a member with a default",
    `const { label = "none" } = awl;\nconsole.log(same(awl, awl), label);`,
  ],
  [
    "is bound by a pattern over a list",
    `const [pick] = [awl];\nconsole.log(same(pick, awl), pick.parts.length);`,
  ],
  [
    "is bound by a pattern over a literal",
    `const { held: pick } = { held: awl };\nconsole.log(same(pick, awl), pick.parts.length);`,
  ],
  [
    "comes out of a list checked by satisfies",
    `import type { Tool } from "./tables.ts";\nconst list = [awl] satisfies Tool[];\nconst pick = list[0]!;\nconsole.log(same(pick, awl), pick.parts.length);`,
  ],
])("a table whose other name %s keeps its own layout", async (_name, body) => {
  const kept = await keepsLayout(`import { awl, same } from "./tables.ts";\n${body}`, RACK);
  expect(kept).toBe(true);
});

// A `require` whose specifier is computed names no module of the program
// (the module graph is fixed when the program is built: the call throws
// when it runs), so it takes no module as a whole object. A `require` of
// the table's module by name still does.
const LOADER = `exports.load = function (name) { return require("./" + name); };`;

test("a computed require elsewhere in the program takes no module whole", async () => {
  const ir = await irOf(
    `import { awl, same } from "./tables.ts";
     import loader from "./loader.cjs";
     if (process.argv.length > 9) console.log(loader.load(process.argv[9]));
     console.log(same(awl, awl), awl.label);`,
    SHED,
    { "loader.cjs": LOADER },
  );
  expect(ir).not.toContain(WIDTH_COPY);
});

test("a require of the table's module by name takes the module whole", async () => {
  const ir = await irOf(
    `import { awl, same } from "./tables.ts";
     import loader from "./loader.cjs";
     console.log(same(awl, awl), awl.label, loader.pick() === awl);`,
    SHED,
    {
      "loader.cjs": `const tables = require("./tables.ts");\nexports.pick = function () { return tables.awl; };`,
    },
  );
  expect(ir).toContain(WIDTH_COPY);
});

// A second binding of a table, and a table that names a table bound to a
// second name: the binding is the table under another name, so both are
// followed and take the layout.
test("a second binding of a table takes the layout with it", async () => {
  const ir = await irOf(
    `${TOOL}
     interface Kit { readonly label: string; readonly best?: Tool }
     function kept(kit: Kit): boolean { return kit.best === kit.best; }
     const blade = { label: "blade" } as const;
     const other = blade;
     const plane = { label: "plane", best: blade } as const;
     console.log(kept(plane), same(blade, other), other.label);`,
  );
  expect(ir).not.toContain(WIDTH_COPY);
});
