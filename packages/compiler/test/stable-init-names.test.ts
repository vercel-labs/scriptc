import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

/** The `%init` name of each module, keyed by its file's base name. */
function initNames(module: IrModule): Map<string, string> {
  const names = new Map<string, string>();
  for (const fn of module.functions)
    if (fn.name.startsWith("%init.")) names.set(basename(fn.loc.file), fn.name);
  return names;
}

test("a module keeps its %init name when another module is added", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-init-names-"));
  try {
    const moduleSource = (name: string) =>
      `export function ${name}(n: number): number {\n  return n + 1;\n}\n`;
    for (const name of ["a", "b", "c"])
      await writeFile(join(dir, `${name}.ts`), moduleSource(name));
    const mainSource = (names: string[]) =>
      [
        ...names.map((name) => `import { ${name} } from "./${name}.js";`),
        `console.log(${names.map((name) => `${name}(1)`).join(" + ")});`,
        "",
      ].join("\n");
    const lower = async (names: string[]): Promise<Map<string, string>> => {
      await writeFile(join(dir, "main.ts"), mainSource(names));
      const result = await compile(join(dir, "main.ts"), {
        outDir: dir,
        outPath: join(dir, "main.ir.json"),
        outputKind: "ir",
      });
      if (!result.ok)
        throw new Error(
          result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
        );
      return initNames(deserializeModule(await readFile(join(dir, "main.ir.json"), "utf8")));
    };
    const before = await lower(["a", "b"]);
    const after = await lower(["a", "b", "c"]);
    expect(before.get("main.ts")).toBe("%init.0");
    expect(after.get("main.ts")).toBe("%init.0");
    expect(after.get("a.ts")).toBe(before.get("a.ts"));
    expect(after.get("b.ts")).toBe(before.get("b.ts"));
    expect(after.has("c.ts")).toBe(true);
    expect(new Set(after.values()).size).toBe(after.size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
