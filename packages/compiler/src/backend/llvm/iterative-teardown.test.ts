import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { emitLlvmModule } from "./emitter.js";

async function moduleFor(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-iterative-teardown-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return deserializeModule(await readFile(output, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SOURCE = `
interface TreeNode { left: TreeNode | null; right: TreeNode | null }
class ListNode {
  next: ListNode | null;
  value: number;
  constructor(next: ListNode | null, value: number) { this.next = next; this.value = value; }
}
interface Labeled { child: Labeled | null; label: string[] }
function tree(d: number): TreeNode { return d > 0 ? { left: tree(d - 1), right: tree(d - 1) } : { left: null, right: null }; }
function size(n: TreeNode | null): number { return n === null ? 0 : 1 + size(n.left) + size(n.right); }
let list: ListNode | null = null;
for (let i = 0; i < 10; i++) list = new ListNode(list, i);
let labeled: Labeled | null = { child: { child: null, label: ["b"] }, label: ["a"] };
console.log(size(tree(4)), list!.value, labeled!.label.length);
list = null;
labeled = null;
`;

/** The definitions whose symbols end in `suffix`. */
function definitions(ir: string, suffix: string): string[] {
  return [
    ...ir.matchAll(new RegExp(`^define internal [^\\n]*@([\\w.$%-]+${suffix})\\(`, "gm")),
  ].map((m) => m[1]!);
}

test("self-recursive records and classes tear down in one loop", async () => {
  const ir = emitLlvmModule(await moduleFor(SOURCE), { targetTriple: "x86_64-unknown-linux-gnu" });
  const loops = definitions(ir, "_destroy_it");
  // The tree record and the list class; the labeled record also holds an
  // array, so it keeps the recursive teardown.
  expect(loops.length).toBe(2);
  expect(loops.some((name) => name.includes("ListNode"))).toBe(true);
  for (const name of loops) {
    const body = new RegExp(
      `^define internal void @${name.replace(/[$.]/g, "\\$&")}\\(ptr %root\\)[^]*?^}`,
      "m",
    ).exec(ir)![0];
    // No call to a teardown: dead children go onto the pending list.
    expect(body).not.toMatch(/call [^\n]*_destroy/);
    expect(body).toContain("inttoptr");
    const base = name.slice(0, -"_it".length);
    expect(ir).toContain(`define internal void @${base}(ptr %o)`);
    expect(ir).not.toContain(`@${base}_s(`);
  }
  expect(definitions(ir, "_destroy_s").length).toBe(1);
});
