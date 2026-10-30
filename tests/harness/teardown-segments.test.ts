/* Teardown segments (llvm/shapes.ts): a typed teardown of a type with
 * children of its own type keeps the blocks it frees in a segment and frees
 * the segment onto the free list when the chain's first teardown returns.
 * Corpus program 7260 pins what such programs print; this suite checks the
 * memory side natively, which Node parity cannot: a program that rebuilds
 * large trees and lists for a hundred generations reuses every block of the
 * last generation, so its resident set stays at about one generation's
 * worth. A segment that lost blocks would grow it by a generation each time.
 * The sanitized lane frees through the system allocator (no segments) and
 * keeps freed memory in quarantine, so the bound is checked in the plain
 * lane only. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const PROGRAM = `
interface Node {
  left: Node | null;
  right: Node | null;
  value: number;
}
function tree(depth: number): Node {
  return depth === 0
    ? { left: null, right: null, value: 1 }
    : { left: tree(depth - 1), right: tree(depth - 1), value: depth };
}
function size(node: Node | null): number {
  return node === null ? 0 : 1 + size(node.left) + size(node.right);
}
class Branch {
  readonly left: Branch | null;
  readonly right: Branch | null;
  constructor(left: Branch | null, right: Branch | null) {
    this.left = left;
    this.right = right;
  }
}
function branches(depth: number): Branch {
  return depth === 0 ? new Branch(null, null) : new Branch(branches(depth - 1), branches(depth - 1));
}
function count(branch: Branch | null): number {
  return branch === null ? 0 : 1 + count(branch.left) + count(branch.right);
}
interface Cell {
  next: Cell | null;
  n: number;
}
function cells(n: number): Cell | null {
  let head: Cell | null = null;
  for (let i = 0; i < n; i++) head = { next: head, n: i };
  return head;
}
let total = 0;
let settled = 0;
for (let generation = 0; generation < 100; generation++) {
  total += size(tree(16)) + count(branches(15));
  for (let c = cells(100000); c !== null; c = c.next) total += 1;
  if (generation === 2) settled = process.memoryUsage.rss();
}
const growth = Math.round((process.memoryUsage.rss() - settled) / (1024 * 1024));
console.log(total, growth);
`;

test.skipIf(sanitize)(
  "rebuilding large trees and lists reuses every block their teardowns free",
  { timeout: 300_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-segments-"));
    try {
      const source = join(dir, "churn.ts");
      await writeFile(source, PROGRAM);
      const result = await compile(source, {
        backend: "llvm",
        outDir: dir,
        outPath: join(dir, "churn"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const { stdout } = await exec(result.binaryPath, [], { timeout: 120_000 });
      const [total, growth] = stdout.trim().split(" ").map(Number);
      // 100 generations of 131071 + 65535 nodes and 100000 cells.
      expect(total).toBe(100 * (131071 + 65535 + 100000));
      // One generation is about 10 MiB; a lost generation per round would be
      // hundreds.
      expect(growth).toBeLessThan(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
