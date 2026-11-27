/* Module-level tree shaking: a package module no live module reads, whose top
 * level has no side effect, leaves the compiled order, so a construct the
 * native build has no lowering for cannot refuse the package for it. A module
 * the program reads, or one with a top-level effect, still compiles and still
 * refuses when it carries such a construct. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function program(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-tree-shake-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    if (!name.endsWith("/")) writeFileSync(path, text);
  }
  return join(dir, "main.ts");
}

const BARREL = `import { used } from "./used.mjs";
import { dead } from "./dead.mjs";
export { used, dead };
`;

const BARREL_TYPES = `export declare function used(): string;
export declare function dead(): string;
`;

function packageFiles(deadModule: string): Record<string, string> {
  return {
    "node_modules/barrelpkg/package.json": JSON.stringify({
      name: "barrelpkg",
      type: "module",
      exports: { ".": { types: "./index.d.mts", default: "./index.mjs" } },
    }),
    "node_modules/barrelpkg/index.mjs": BARREL,
    "node_modules/barrelpkg/index.d.mts": BARREL_TYPES,
    "node_modules/barrelpkg/used.mjs": 'export function used() {\n  return "used";\n}\n',
    "node_modules/barrelpkg/dead.mjs": deadModule,
  };
}

/** A function body the native subset has no lowering for ("code from
 * strings"), reachable only through the package's dead export. */
const DEAD_FENCED = `export function dead() {
  return new Function("return 1")();
}
`;

async function build(entry: string): Promise<{ ok: boolean; messages: string[] }> {
  const result = await compile(entry, {
    outPath: entry.replace(/\.ts$/, ""),
    outDir: dirname(entry),
    nodeIslands: { mode: "off" },
  });
  return {
    ok: result.ok,
    messages: (result.ok ? [] : result.diagnostics).map((d) => `${d.code}: ${d.message}`),
  };
}

describe("module-level tree shaking", () => {
  test("a dead module with a fence does not refuse the package", async () => {
    const entry = program({
      ...packageFiles(DEAD_FENCED),
      "main.ts": 'import { used } from "barrelpkg";\nconsole.log(used());\n',
    });
    const result = await build(entry);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a read module with a fence still refuses the package", async () => {
    const entry = program({
      ...packageFiles(DEAD_FENCED),
      "main.ts": 'import { dead } from "barrelpkg";\nconsole.log(dead());\n',
    });
    const result = await build(entry);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("code from strings");
  });

  test("a dead module with a top-level effect is kept and still refuses", async () => {
    const entry = program({
      ...packageFiles(`globalThis.__dead = 1;
export function dead() {
  return new Function("return 1")();
}
`),
      "main.ts": 'import { used } from "barrelpkg";\nconsole.log(used());\n',
    });
    const result = await build(entry);
    expect(result.ok).toBe(false);
    expect(result.messages.join("\n")).toContain("code from strings");
  });
});
