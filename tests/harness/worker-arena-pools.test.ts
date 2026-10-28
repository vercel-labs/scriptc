/* Group arenas (runtime scr_arena.c): each thread keeps up to 8 MB of
 * arena chunks and its dropped arenas for reuse, and a worker thread frees
 * them when its script finishes. This suite runs workers one after another,
 * each building and dropping trees of about 12 MB in a group arena, and
 * checks that the resident set stays flat across them: a worker that kept
 * its pool would add about 8 MB each. Under SCRIPTC_SAN=1 the runtime
 * keeps every worker's memory, so the check does not apply. */
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
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

interface TreeNode {
  left: TreeNode | null;
  right: TreeNode | null;
}

function tree(depth: number): TreeNode {
  return depth > 0 ? { left: tree(depth - 1), right: tree(depth - 1) } : { left: null, right: null };
}

function count(node: TreeNode): number {
  if (node.left === null || node.right === null) return 1;
  return 1 + count(node.left) + count(node.right);
}

function work(depth: number): number {
  let total = 0;
  for (let i = 0; i < 2; i++) total += count(tree(depth));
  return total;
}

function runWorker(depth: number): Promise<number> {
  return new Promise((resolve) => {
    let total = 0;
    const worker = new Worker(new URL(import.meta.url), { workerData: depth });
    worker.on("message", (message: number) => {
      total = message;
    });
    worker.on("exit", () => resolve(total));
  });
}

async function main(): Promise<void> {
  let total = 0;
  let settled = 0;
  for (let i = 0; i < 24; i++) {
    total += await runWorker(18);
    if (i === 3) settled = process.memoryUsage.rss();
  }
  const growth = Math.round((process.memoryUsage.rss() - settled) / (1024 * 1024));
  console.log(total, growth);
}

if (isMainThread) {
  await main();
} else {
  parentPort!.postMessage(work(workerData as number));
}
`;

test.skipIf(process.platform !== "linux" || sanitize)(
  "workers that use group arenas free their arena pools when they exit",
  { timeout: 300_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-worker-arena-pools-"));
    try {
      const source = join(dir, "pools.ts");
      await writeFile(source, PROGRAM);
      const result = await compile(source, {
        backend: "llvm",
        outDir: dir,
        outPath: join(dir, "pools"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const { stdout } = await exec(result.binaryPath, [], {
        env: { ...process.env, SCR_SA_DISCARD_DELAY_MS: "0" },
        timeout: 120_000,
      });
      const [total, growth] = stdout.trim().split(" ").map(Number);
      // 24 workers, each with 2 trees of 2^19 - 1 nodes.
      expect(total).toBe(24 * 2 * (2 ** 19 - 1));
      // 20 workers that kept their pools would add about 160 MiB.
      expect(growth).toBeLessThan(32);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
