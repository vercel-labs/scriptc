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
  const program = `const pairs: [number, number][] = [[1, 2]];\nconst [[a, b]] = pairs;\nconsole.log(a + b);\nconst { length } = [1, 2] as number[];\nconsole.log(length);\n`;
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
