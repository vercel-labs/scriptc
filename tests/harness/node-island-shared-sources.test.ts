/* Which program modules a program shares with its Node islands, and what
 * of them the executable carries (scope-B NI-6). Builds to IR only: no
 * libnode is needed. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile, type ir } from "@scriptc/compiler";

// Outside any node_modules directory: a program there would be a package.
const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-island-shared-")));

const MAIN = `import { requireModule } from "@scriptc/node";
import { tally } from "./tally.mjs";
const plugin = requireModule("./plugin.mjs");
console.log(tally(), plugin.name);
`;
const TALLY = `// tally: internal counting rules
let n = 0;
export function tally() { return ++n; }
`;

async function irOf(name: string, plugin: string): Promise<ir.IrModule> {
  const dir = join(cacheDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.mjs"), MAIN);
  writeFileSync(join(dir, "tally.mjs"), TALLY);
  writeFileSync(join(dir, "plugin.mjs"), plugin);
  const result = await compile(join(dir, "main.mjs"), {
    outputKind: "ir",
    outPath: join(dir, "program.ir.json"),
    outDir: dir,
    backend: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return JSON.parse(readFileSync(result.artifact.path, "utf8")) as ir.IrModule;
}

function sharedPaths(mod: ir.IrModule): string[] {
  const out: string[] = [];
  JSON.stringify(mod, (_k, v: unknown) => {
    const o = v as { kind?: string; fn?: string; args?: { kind?: string; value?: string }[] };
    if (o !== null && typeof o === "object" && o.kind === "libCall" && o.fn === "nodeIsland.share")
      for (const a of o.args ?? [])
        if (a.kind === "strLit" && a.value !== undefined) out.push(a.value);
    return v;
  });
  return out;
}

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("program modules shared with Node islands", () => {
  test("a specifier in a comment of island code shares nothing", async () => {
    const mod = await irOf(
      "comment",
      `// This plugin never imports "./tally.mjs": import { tally } from "./tally.mjs";\nexport const name = "plugin";\n`,
    );
    expect(sharedPaths(mod).some((p) => p.endsWith("tally.mjs"))).toBe(false);
  });

  test("a shared module's source stays out of the shipped tree", async () => {
    const mod = await irOf(
      "import",
      `import { tally } from "./tally.mjs";\nexport const name = "plugin:" + tally();\n`,
    );
    expect(sharedPaths(mod).some((p) => p.endsWith("tally.mjs"))).toBe(true);
    const tree = mod.nodeIsland?.modules;
    expect(tree).toBeDefined();
    const entry = tree!.files.find((f) => f.path.endsWith("tally.mjs"));
    expect(entry?.placeholder).toBe(true);
    expect(tree!.files.map((f) => f.path).sort()).toEqual(["plugin.mjs", "tally.mjs"]);
  });
});
