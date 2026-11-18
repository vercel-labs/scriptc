/* A var's settlement proof asks whether the function declarations that read
 * the binding all run after its store. Those functions call each other, so a
 * proof regularly leans on a call cycle being proven: the answer holds only
 * if the cycle's root does. Keeping every such answer out of the memo (the
 * regression this test pins) makes a module whose call graph is full of
 * cycles re-prove the same functions once for every typed binding, which is
 * what made a react-dom/server build spend minutes in reachable-emit. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../../index.js";
import { countSettleProofs, settleProofCounts } from "./var-hoisting.js";

/** A module whose mutually recursive functions read a `var` declared after
 * them. Every read of `a` makes the analysis prove `ping` (and the functions
 * it reaches) settle; the cycle means each proof leans on the optimistic
 * answer for `ping` itself. */
const CYCLIC_FORWARD_READS = `function ping(): number {
  return pong() + a + a + a + a + a + a + a + a;
}
function pong(): number {
  return ping();
}
var a = 1;
console.log(ping, pong, a);
`;

async function proofCounts(source: string): Promise<ReadonlyMap<string, number>> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-settle-proofs-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    countSettleProofs();
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ir.json"),
      outputKind: "ir",
    });
    expect(result.ok).toBe(true);
    return settleProofCounts();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a build proves each function/settle key at most once", async () => {
  const counts = await proofCounts(CYCLIC_FORWARD_READS);
  expect(counts.size).toBeGreaterThan(0);
  const repeated = [...counts].filter(([, count]) => count > 1);
  expect(repeated).toEqual([]);
});
