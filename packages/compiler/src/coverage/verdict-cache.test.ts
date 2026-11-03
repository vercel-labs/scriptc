import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { analyze } from "../index.js";
import { analyzeWithVerdictCache, type VerdictStore } from "./verdict-cache.js";
import { commentOnlyReplay } from "./verdict-semantic.js";

const dir = mkdtempSync(join(tmpdir(), "scriptc-verdict-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("unchanged and comment-only reruns replay the verdict; code edits relower", () => {
  const entry = join(dir, "main.ts");
  // The blocker: an object pattern over a union source (arrays alone compile).
  const program = `const pairs: [number, number][] = [[1, 2]];\nconst [[a, b]] = pairs;\nconsole.log(a + b);\nconst { length } = (a > 9 ? [1, 2] : "ab") as number[] | string;\nconsole.log(length);\n`;
  writeFileSync(entry, program);
  const entries = new Map<string, string>();
  const store: VerdictStore = {
    read: (k) => entries.get(k) ?? null,
    write: (k, t) => void entries.set(k, t),
  };
  let lowered = 0;
  const run = () => {
    const { result, outcome } = analyzeWithVerdictCache(
      entry,
      {},
      {
        store,
        identity: "test",
        platform: process.platform,
        semanticReplay: commentOnlyReplay,
      },
      () => {
        lowered++;
        return analyze(entry);
      },
    );
    return { ...result, cache: outcome };
  };
  const first = run();
  expect(first.cache).toBe("miss");
  const blockerStart = first.coverage.diagnostics[0]?.loc.start;
  expect(blockerStart).toBeDefined();

  const second = run();
  expect(second.cache).toBe("hit");
  expect(lowered).toBe(1);
  expect(second.coverage).toEqual(first.coverage);

  // A comment edit shifts every location by the inserted text.
  const prefix = "// a note about the pairs\n";
  writeFileSync(entry, prefix + program);
  const third = run();
  expect(third.cache).toBe("semantic-hit");
  expect(lowered).toBe(1);
  expect(third.coverage.diagnostics[0]!.loc.start).toBe(blockerStart! + prefix.length);
  expect(third.sourceTexts.get(entry)).toBe(readFileSync(entry, "utf8"));

  writeFileSync(entry, prefix + program + "console.log(1);\n");
  expect(run().cache).toBe("miss");
  expect(lowered).toBe(2);
});

test("reached-only coverage caches under its own key", () => {
  // The reached verdict is not the whole-program one: the same entry must
  // not replay a full report for a reached run, or the reverse.
  const entry = join(dir, "reached.ts");
  writeFileSync(entry, `const [[a, b]] = [[1, 2]];\nconsole.log(a + b);\n`);
  const entries = new Map<string, string>();
  const store: VerdictStore = {
    read: (k) => entries.get(k) ?? null,
    write: (k, t) => void entries.set(k, t),
  };
  const run = (opts: { coverageReached?: boolean }) =>
    analyzeWithVerdictCache(
      entry,
      opts,
      { store, identity: "test", platform: process.platform, semanticReplay: commentOnlyReplay },
      () => analyze(entry, opts),
    );
  const full = run({});
  expect(full.outcome).toBe("miss");
  const reached = run({ coverageReached: true });
  expect(reached.outcome).toBe("miss");
  expect(reached.result.coverage.unreached).toBeUndefined();
  expect(reached.result.coverage.reachedOnly).toBe(true);
  // Both verdicts replay from their own entries.
  expect(run({}).outcome).toBe("hit");
  expect(run({ coverageReached: true }).outcome).toBe("hit");
  expect(run({}).result.coverage.unreached).toBeDefined();
  expect(run({ coverageReached: true }).result.coverage.unreached).toBeUndefined();
});
