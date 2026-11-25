import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../../index.js";

async function llvmFor(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-tree-units-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "llvm" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    return await readFile(output, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One emitted function, from its definition line through the closing brace. */
function functionBody(llvm: string, name: string): string {
  return new RegExp(`^define [^\\n]*@${name}\\([^\\n]*\\n[\\s\\S]*?^}`, "m").exec(llvm)?.[0] ?? "";
}

/** A two-child tree class and a one-child chain, both with `C | T` children,
 * plus the string-holding chain that keeps their group open so the trees keep
 * the heap path and their walking teardowns rather than the arena's drop. */
const tree = (suffix: string): string => `
type MaybeNode = Node${suffix};
type MaybeLink = Link${suffix};

class Node {
  readonly left: MaybeNode;
  readonly right: MaybeNode;
  readonly value: number;
  constructor(left: MaybeNode, right: MaybeNode, value: number) {
    this.left = left;
    this.right = right;
    this.value = value;
  }
}

class Link {
  readonly next: MaybeLink;
  readonly value: number;
  constructor(next: MaybeLink, value: number) {
    this.next = next;
    this.value = value;
  }
}

function build(depth: number): Node {
  if (depth === 0) return new Node(null, null, 1);
  const left = build(depth - 1);
  const right = build(depth - 1);
  return new Node(left, right, 1);
}

function link(count: number): Link {
  if (count === 0) return new Link(null, 1);
  const tail = link(count - 1);
  return new Link(tail, 1);
}

function nodes(node: MaybeNode): number {
  if (node === null || node === undefined) return 0;
  return node.value + nodes(node.left) + nodes(node.right);
}

function links(item: MaybeLink): number {
  if (item === null || item === undefined) return 0;
  return item.value + links(item.next);
}

interface Item {
  label: string;
  next: Item | null;
}
function chain(labels: string[], n: number): Item {
  if (n === 0) return { label: labels[0]!, next: null };
  return { label: labels[n % labels.length]!, next: chain(labels, n - 1) };
}
function length(item: Item): number {
  if (item.next === null) return item.label.length;
  return item.label.length + length(item.next);
}

const labels = ["a", "bb"];
let total = 0;
for (let round = 0; round < 3; round++)
  total += length(chain(labels, 4)) + nodes(build(3)) + links(link(9));
console.log(total);
`;

test("a tree teardown skips both unit encodings of a C | null | undefined child", async () => {
  const llvm = await llvmFor(tree(" | null | undefined"));
  // The class is a tree without a count word.
  expect(llvm).toContain("%sc_o_Node = type { ptr, ptr, i32 } ; class Node (no count: a tree)");
  // The two-child loop and its per-node fallback ask for a node, not a unit:
  // NULL (undefined) and the immortal null sentinel both fail the test.
  const twoChild = functionBody(llvm, "sc_release_Node_destroy_it");
  expect(twoChild).toContain("%it.t0.unit = icmp ne ptr %it.v0, @sc_nullable_null");
  expect(twoChild).toContain("%it.v0n = and i1 %it.t0.null, %it.t0.unit");
  expect(twoChild).toContain("%it.t1.unit = icmp ne ptr %it.v1, @sc_nullable_null");
  expect(twoChild).toContain("%it.v1n = and i1 %it.t1.null, %it.t1.unit");
  expect(twoChild).toContain("%it.t2.unit = icmp ne ptr %it.v1, @sc_nullable_null");
  expect(twoChild).toContain("%it.v1n2 = and i1 %it.t2.null, %it.t2.unit");
  const fallback = functionBody(llvm, "sc_release_Node_destroy_one");
  expect(fallback).toContain("%one.t0.unit = icmp ne ptr %one.v0, @sc_nullable_null");
  expect(fallback).toContain("%one.v0n = and i1 %one.t0.null, %one.t0.unit");
  expect(fallback).toContain("%one.t1.unit = icmp ne ptr %one.v1, @sc_nullable_null");
  // The single-child loop skips them too.
  const oneChild = functionBody(llvm, "sc_release_Link_destroy_it");
  expect(oneChild).toContain("%it.chk.unit = icmp ne ptr %it.v0, @sc_nullable_null");
  expect(oneChild).toContain("%it.nn = and i1 %it.chk.null, %it.chk.unit");
  // A value of the union can reach the class's release as the sentinel, and
  // a tree has no count to recognise it by: the release returns before it
  // tears anything down.
  const release = functionBody(llvm, "sc_release_Node");
  expect(release).toContain("notunit: ; the null arm of a two-unit nullable union");
  expect(release).toContain("%isunit = icmp eq ptr %o, @sc_nullable_null");
  expect(release).toMatch(/br i1 %isunit, label %done, label %free/);
});

test("a C | null child keeps the teardown byte-identical: one unit arm, no sentinel", async () => {
  const llvm = await llvmFor(tree(" | null"));
  expect(llvm).not.toContain("@sc_nullable_null");
  expect(functionBody(llvm, "sc_release_Node_destroy_it")).toContain(
    "%it.v0n = icmp ne ptr %it.v0, null",
  );
  expect(functionBody(llvm, "sc_release_Node")).not.toContain("isunit");
});
