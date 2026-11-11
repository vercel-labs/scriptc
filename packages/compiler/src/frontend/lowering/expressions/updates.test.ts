import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { analyze } from "../../../index.js";
import { Lowerer } from "../lowerer.js";

test.for([
  ["consumed", "console.log(", ");"],
  ["discarded", "", ";"],
])("a %s negation chain does linear work around an independently admitted IIFE body", (row) => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-negation-work-"));
  const query = vi.spyOn(Lowerer.prototype, "opinionAtNode");
  try {
    const counts = [16, 32].map((length) => {
      const entry = join(directory, `chain-${length}.mjs`);
      writeFileSync(
        entry,
        `function effect() { console.log("effect"); }\n${row[1]}${"!".repeat(length)}(() => { !effect(); return false; })()${row[2]}`,
      );
      query.mockClear();
      const { coverage } = analyze(entry);
      expect(coverage.preflightFailed).toBe(false);
      expect(coverage.diagnostics).toEqual([]);
      expect(coverage.runtimeFences ?? []).toEqual([]);
      expect(coverage.stats.statementsFailed).toBe(0);
      return query.mock.calls.length;
    });
    expect(counts[1]!).toBeLessThanOrEqual(counts[0]! * 2 + 8);
  } finally {
    query.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
