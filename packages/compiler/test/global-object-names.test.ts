/* `key in globalThis` answers from one list: the names of Node's global
 * object the compiler hands the runtime (global-object-names.ts). The list is
 * derived from the standard library's declarations; this test holds it
 * against the running Node, the release the differential corpus runs. */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { NODE_GLOBALS_WITHOUT_NATIVE } from "../src/frontend/lowering/host-globals.js";

/** The table a program's `in` over the global object carries. */
async function presentNames(extension: string, source: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-global-names-"));
  try {
    const entry = join(dir, `main.${extension}`);
    await writeFile(entry, source);
    const out = join(dir, ".scriptc", "main.ir.json");
    const result = await compile(entry, {
      outDir: join(dir, ".scriptc"),
      outPath: out,
      outputKind: "ir",
    });
    expect(result.ok ? [] : result.diagnostics.map((diag) => diag.message)).toEqual([]);
    const key = /"%globalThis\.present:([^"]*)"/.exec(readFileSync(out, "utf8"));
    expect(key).not.toBeNull();
    return key![1]!.split(",");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every string key `in` finds on Node's global object: its own names and
 * the ones it inherits, without the ones the test runner adds. */
function nodeNames(): Set<string> {
  const names = new Set<string>();
  for (
    let object: object | null = globalThis;
    object !== null;
    object = Object.getPrototypeOf(object) as object | null
  )
    for (const name of Object.getOwnPropertyNames(object))
      if (!name.startsWith("__vitest_")) names.add(name);
  return names;
}

for (const [extension, source] of [
  ["ts", 'console.log("Array" in globalThis);\n'],
  ["mjs", 'console.log("Array" in globalThis);\n'],
  ["cjs", 'console.log("Array" in globalThis);\n'],
] as const) {
  test(`the names a .${extension} source's \`in\` answers true for are Node's`, async () => {
    const present = await presentNames(extension, source);
    const node = nodeNames();
    // Nothing the list has is absent in Node.
    expect(present.filter((name) => !node.has(name))).toEqual([]);
    // Everything Node has is in the list, or is a global native code does
    // not provide, which the runtime refuses by name before it asks the list.
    expect(
      [...node].filter((name) => !present.includes(name) && !NODE_GLOBALS_WITHOUT_NATIVE.has(name)),
    ).toEqual([]);
    expect(present).toEqual([...present].sort());
  });
}
