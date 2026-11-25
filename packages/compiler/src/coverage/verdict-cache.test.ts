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

test("a reached-only verdict never replays a full one", () => {
  const entry = join(dir, "modes.ts");
  writeFileSync(
    entry,
    `function used(n: number): number {\n  return n + 1;\n}\nfunction unused(): void {\n  console.log("x");\n}\nconsole.log(used(1));\n`,
  );
  const entries = new Map<string, string>();
  const store: VerdictStore = {
    read: (k) => entries.get(k) ?? null,
    write: (k, t) => void entries.set(k, t),
  };
  let lowered = 0;
  const run = (coverage?: "reached") => {
    const { result, outcome } = analyzeWithVerdictCache(
      entry,
      coverage === undefined ? {} : { coverage },
      { store, identity: "test", platform: process.platform },
      () => {
        lowered++;
        return analyze(entry, coverage === undefined ? {} : { coverage });
      },
    );
    return { ...result, cache: outcome };
  };
  const full = run();
  expect(full.cache).toBe("miss");
  expect(full.coverage.unreached).toBeDefined();
  const reached = run("reached");
  expect(reached.cache).toBe("miss");
  expect(lowered).toBe(2);
  expect(reached.coverage.reachedOnly).toBe(true);
  expect(reached.coverage.unreached).toBeUndefined();
  // Each mode replays its own entry, and the replayed verdict keeps its
  // mode.
  expect(run().cache).toBe("hit");
  const again = run("reached");
  expect(again.cache).toBe("hit");
  expect(lowered).toBe(2);
  expect(again.coverage.reachedOnly).toBe(true);
});
