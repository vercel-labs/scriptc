import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { analyze } from "../../../index.js";
import { Lowerer } from "../lowerer.js";

test.for([
  { use: "consumed", before: "console.log(", after: ");", sites: 1 },
  { use: "discarded", before: "", after: ";", sites: 1 },
  { use: "consumed", before: "console.log(", after: ");", sites: 32 },
  { use: "discarded", before: "", after: ";", sites: 32 },
])("a $use negation chain bounds exact-site queries with $sites unrelated sites", (row) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-negation-work-"));
  const query = vi.spyOn(Lowerer.prototype, "opinionAtNode");
  try {
    const statements = "!effect();".repeat(row.sites);
    const counts = [16, 32].map((length) => {
      const entry = join(directory, `chain-${length}.mjs`);
      writeFileSync(
        entry,
        `function effect() { console.log("effect"); }\n${row.before}${"!".repeat(length)}(() => { ${statements} return false; })()${row.after}`,
      );
      query.mockClear();
      const { coverage } = analyze(entry);
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.runtimeFences ?? []).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
      return query.mock.calls.filter(([, code]) => code === 1345).length;
    });
    // An exact query scans the file's admitted sites. More outer bangs
    // must not multiply those scans when the sites belong to the IIFE.
    expect(counts[1]!).toBeLessThanOrEqual(counts[0]! + 2);
  } finally {
    query.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
