import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const testDir = import.meta.dirname;
const repoRoot = join(testDir, "..", "..", "..");
const generator = join(repoRoot, "scripts", "gen-intrinsics.mjs");
const header = join(testDir, "..", "src", "scr_js_intrinsics_table.h");
const ids = join(
  repoRoot,
  "packages",
  "compiler",
  "src",
  "frontend",
  "lowering",
  "intrinsic-ids.generated.ts",
);

// The table is Node's own object graph: scripts/gen-intrinsics.mjs prints it
// by reading the intrinsics of the pinned release (.node-version). The
// runtime and the frontend compile against the committed outputs, so a
// release bump that changes a member, an attribute or a [[Prototype]] must
// regenerate them; this test is what says so.
const pinned = `v${readFileSync(join(repoRoot, ".node-version"), "utf8").trim()}`;
// The pin check is the point: a leftover override in the environment would
// let an unpinned Node print a table this test would then accept.
const { SCRIPTC_INTRINSICS_ANY_NODE: _unpinned, ...env } = process.env;
const run = (args: string[]) =>
  execFileSync(process.execPath, [generator, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env,
  });

test.skipIf(process.version !== pinned)(`the intrinsic table is the ${pinned} object graph`, () => {
  expect(run([])).toBe(readFileSync(header, "utf8"));
  expect(run(["--ts"])).toBe(readFileSync(ids, "utf8"));
});

test("the table names every intrinsic the compiler may lower", () => {
  // The generated header and the generated id set come from one run, so the
  // ids the frontend lowers are exactly the objects the runtime builds.
  const table = readFileSync(header, "utf8");
  const idSet = readFileSync(ids, "utf8");
  const rows = table.match(/^\s+X\("/gm) ?? [];
  expect(rows.length).toBeGreaterThan(700);
  for (const id of idSet.match(/"([^"]+)"/g) ?? []) {
    expect(table).toContain(id);
  }
});
