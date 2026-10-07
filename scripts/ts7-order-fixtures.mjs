import { globSync } from "node:fs";
import { join } from "node:path";

export function orderEntriesUnder(repoRoot, dir) {
  return ["ts", "js", "mjs", "cjs"]
    .flatMap((ext) => [
      ...globSync(join(repoRoot, dir, `*.${ext}`)),
      ...globSync(join(repoRoot, dir, `*/main.${ext}`)),
    ])
    .sort();
}

export function allOrderEntries(repoRoot) {
  return [
    ...orderEntriesUnder(repoRoot, "tests/corpus"),
    ...orderEntriesUnder(repoRoot, "tests/diagnostics"),
    ...orderEntriesUnder(repoRoot, "tests/fixtures/npm/cases"),
    ...globSync(join(repoRoot, "tests/fixtures/strictness/*/main.ts")).sort(),
    ...globSync(join(repoRoot, "tests/fixtures/node-types/*.ts")).sort(),
  ];
}
