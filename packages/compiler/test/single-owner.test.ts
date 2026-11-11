/* `class C implements SingleOwner` (@scriptc/experimental,
 * backend/tree-classes.ts): the marker asks for the tree-class layout, in
 * which instances carry no reference count, and makes the analysis's
 * rejection reasons a diagnostic (SC7010) instead of a silent fallback to
 * the counted layout. Under Node.js the marker is erased. */
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

const repoRoot = join(import.meta.dirname, "../../..");

async function build(source: string): Promise<{
  ok: boolean;
  codes: string[];
  messages: string[];
  hints: string[];
  llvm: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-single-owner-"));
  try {
    // The workspace's packages, so that the program resolves the import.
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    const llvm = result.ok ? await readFile(outPath, "utf8") : "";
    return {
      ok: result.ok,
      codes: (result.diagnostics ?? []).map((d) => d.code),
      messages: (result.diagnostics ?? []).map((d) => d.message),
      hints: (result.diagnostics ?? []).map((d) => d.hint ?? ""),
      llvm,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TREE = `
import type { SingleOwner } from "@scriptc/experimental";

class TreeNode implements SingleOwner {
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
  readonly weight: number;
  constructor(left: TreeNode | null, right: TreeNode | null, weight: number) {
    this.left = left;
    this.right = right;
    this.weight = weight;
  }
}

function build(depth: number): TreeNode | null {
  if (depth === 0) return null;
  return new TreeNode(build(depth - 1), build(depth - 1), 1);
}

function total(node: TreeNode | null): number {
  if (node === null) return 0;
  // A const alias of a field read: the node stays alive for the call.
  const left = node.left;
  return node.weight + total(left) + total(node.right);
}

console.log(total(build(4)));
`;

const nodeCounted = (llvm: string): boolean => /%sc_o_TreeNode = type \{ i64,/.test(llvm);
const nodeTree = (llvm: string): boolean =>
  /%sc_o_TreeNode = type \{ ptr, ptr, i32 \} ; class TreeNode \(no count/.test(llvm);

test("a marked class the proof accepts drops its reference count", async () => {
  const result = await build(TREE);
  expect(result.codes).toEqual([]);
  expect(nodeTree(result.llvm)).toBe(true);
  expect(nodeCounted(result.llvm)).toBe(false);
});

test("undefined is as good an absence as null", async () => {
  const result = await build(
    TREE.replaceAll("TreeNode | null", "TreeNode | undefined")
      .replaceAll("=== null", "=== undefined")
      .replaceAll("return null", "return undefined"),
  );
  expect(result.codes).toEqual([]);
  expect(nodeTree(result.llvm)).toBe(true);
});

test("the marker is erased from an accepted program's behavior", async () => {
  const marked = await build(TREE);
  const plain = await build(
    TREE.replace('import type { SingleOwner } from "@scriptc/experimental";\n', "").replace(
      " implements SingleOwner",
      "",
    ),
  );
  // Same program, same layout: the marker adds the check, not the lowering.
  const shape = (llvm: string): string =>
    llvm
      .split("\n")
      .filter((line) => line.startsWith("define") || line.startsWith("%sc_o_TreeNode"))
      .join("\n");
  expect(shape(marked.llvm)).toBe(shape(plain.llvm));
});

test("a rejected marked class reports the rule that would hold a node twice", async () => {
  const result = await build(
    `${TREE}\nfunction countAll(nodes: TreeNode[]): number {\n  let n = 0;\n  for (const node of nodes) if (node !== null) n++;\n  return n;\n}\nconsole.log(countAll([]));\n`,
  );
  expect(result.ok).toBe(false);
  expect(result.codes).toEqual(["SC7010"]);
  expect(result.messages[0]).toContain("'TreeNode' cannot keep its SingleOwner contract");
  expect(result.messages[0]).toContain("countAll parameter nodes holds it");
  expect(result.hints[0]).toContain("remove `implements SingleOwner`");
});

test("the diagnostic names a local as the source writes it", async () => {
  // Reading a field of a node the function owns is a view: an alias that
  // could outlive the owner. The reason names the alias, not its IR id.
  const result = await build(
    `${TREE}\nfunction head(): number {\n  const root = build(3);\n  if (root === null) return 0;\n  const first = root.left;\n  return first === null ? 0 : first.weight;\n}\nconsole.log(head());\n`,
  );
  expect(result.ok).toBe(false);
  expect(result.codes).toEqual(["SC7010"]);
  expect(result.messages[0]).toContain("in head, local 'first' aliases a node it does not own");
});

test("the marker outside an implements clause is refused", async () => {
  const result = await build(
    `import type { SingleOwner } from "@scriptc/experimental";\ntype Point = SingleOwner<{ x: number }>;\nconst p: Point = { x: 1 };\nconsole.log(p.x);\n`,
  );
  expect(result.ok).toBe(false);
  expect(result.codes).toEqual(["SC7006"]);
  expect(result.hints[0]).toContain("class Node implements SingleOwner");
});
