import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** The serialized IR of a program that must compile. */
async function irOf(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-layout-adoption-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, `export {};\n${source}`);
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
    "a second binding of the table",
    `${TOOL}
     const awl = { label: "awl" } as const;
     const spare = awl;
     console.log(same(awl, spare));`,
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
    "a table that names a table bound to a second name",
    `${TOOL}
     interface Kit { readonly label: string; readonly best?: Tool }
     function kept(kit: Kit): boolean { return kit.best === kit.best; }
     const blade = { label: "blade" } as const;
     const other = blade;
     const plane = { label: "plane", best: blade } as const;
     console.log(kept(plane), other.label);`,
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
