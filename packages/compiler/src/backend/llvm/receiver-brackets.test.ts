import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { emitLlvmModule } from "./emitter.js";

async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-receiver-brackets-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return emitLlvmModule(deserializeModule(await readFile(output, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function body(ir: string, name: string): string {
  const match = new RegExp(`^define [^\\n]*@${name}\\(.*?^}`, "ms").exec(ir);
  if (!match) throw new Error(`no function ${name}`);
  return match[0];
}

test("a known signature adapter's direct entry brackets the receiver only when its original reads it", async () => {
  const ir = await llvmFor(`
class Node {
  kids: Node[] = [];
  constructor(readonly kind: number) {}
}
function walk(root: Node, cb: (node: Node, depth: number) => void | "skip" | "stop"): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const verdict = cb(node, stack.length);
    if (verdict === "stop") return;
    if (verdict === "skip") continue;
    for (const kid of node.kids) stack.push(kid);
  }
}
class Counter {
  count = 0;
  run(root: Node): number {
    walk(root, (node) => {
      if (node.kind === 3) this.count++;
    });
    return this.count;
  }
}
const root = new Node(0);
root.kids.push(new Node(3));
console.log(new Counter().run(root));
`);
  const walk = body(ir, "sc_bf_walk");
  const blocks = walk.split(/^(?=[\w.]+:$)/m);
  const direct = blocks.find((block) => block.startsWith("callback.direct"));
  // The adapter forwards the receiver to the arrow function, which never
  // reads it: the direct entry tests the closure's RECEIVER_FREE bit, and
  // every receiver push is behind such a test.
  expect(direct).toMatch(/ = and i32 %\S+, 16\n/);
  const pushes = blocks.filter((block) => block.includes("@scr_dyn_this_push_dyn"));
  expect(pushes.length).toBeGreaterThan(0);
  for (const block of pushes) expect(block).toMatch(/^receiver\.push\d+:/);
});
