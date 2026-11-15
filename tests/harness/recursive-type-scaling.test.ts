/* Compile time does not grow with the number of ways a recursive type leads
 * back to itself. A slot whose type has no static lowering is committed
 * through the canonical form (canon-map.ts), which mapped a recursive type
 * again along every path through it, down to its depth cap: a tagged tree
 * with a leaf that does not compile took 1.5 seconds with three branch arms,
 * 20 seconds with five, and a real project's 17-arm tree never finished.
 * Each node maps once per depth now. Behavior of such a program is pinned by
 * corpus 8795; this test bounds the compile at a size the repeated mapping
 * could not finish. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
// Sanitized builds compile the runtime with each uncached build; the
// frontend work this test bounds is the same in every lane.
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** A tagged tree with `arms` branch arms, each holding the tree in an
 * array, and a leaf whose value has no static lowering. */
function program(arms: number): string {
  const lines = [
    `interface JsonList extends Array<Json> {}`,
    `interface JsonObject { [key: string]: Json }`,
    `type Json = string | number | boolean | null | JsonList | JsonObject;`,
    `interface Base { note?: string }`,
  ];
  const names: string[] = [];
  for (let i = 0; i < arms; i++) {
    lines.push(`interface Branch${i} extends Base { kind: "b${i}"; items: Tree[] }`);
    names.push(`Branch${i}`);
  }
  lines.push(
    `interface Leaf extends Base { kind: "leaf"; value: Json }`,
    `type Tree = ${names.join(" | ")} | Leaf;`,
    `interface Slot { tree: Tree; name: string }`,
    `const LEAF: Leaf = { kind: "leaf", value: "x" };`,
    `const SLOT: Slot = { tree: LEAF, name: "top" };`,
    `function depth(tree: Tree): number {`,
    `  if (tree.kind === "leaf") return 0;`,
    `  let most = 0;`,
    `  for (const item of tree.items) most = Math.max(most, depth(item));`,
    `  return most + 1;`,
    `}`,
    `console.log(SLOT.name, SLOT.tree.kind, depth(SLOT.tree));`,
  );
  return lines.join("\n") + "\n";
}

test.skipIf(sanitize)(
  "a recursive tree with twelve branch arms and an uncompilable leaf compiles and runs",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "scriptc-recursive-type-"));
    try {
      const entry = join(dir, "tree.ts");
      const binary = join(dir, "tree");
      writeFileSync(entry, program(12));
      await execFileAsync(
        process.execPath,
        [join(repoRoot, "packages/cli/dist/main.js"), "build", entry, "-o", binary],
        { env: { ...process.env, SCRIPTC_NO_CACHE: "1" }, maxBuffer: 16 * 1024 * 1024 },
      );
      const run = await execFileAsync(binary, [], { encoding: "utf8" });
      expect(run.stdout).toBe("top leaf 0\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
