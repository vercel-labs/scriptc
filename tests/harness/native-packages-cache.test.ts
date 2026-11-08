import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expect, test } from "vitest";

// CI restores the LLVM helper and the runtime pack from caches keyed by the
// files their builds read (.github/actions/native-packages). A build input
// missing from a key restores the artifact built from the old input: a
// refreshed runtime profile was not built into the pack CI tested until the
// next change to a runtime source.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const action = load(
  readFileSync(join(repoRoot, ".github/actions/native-packages/action.yml"), "utf8"),
) as { runs: { steps: { id?: string; uses?: string; with?: { key?: string } }[] } };

/** The patterns of the hashFiles call in the restore step `id`'s key. */
function keyPatterns(id: string): string[] {
  const step = action.runs.steps.find(
    (candidate) => candidate.id === id && candidate.uses?.startsWith("actions/cache/restore@"),
  );
  const call = /hashFiles\(([^)]*)\)/.exec(step?.with?.key ?? "");
  expect(call, `the ${id} cache key hashes its inputs`).not.toBeNull();
  return [...call![1]!.matchAll(/'([^']*)'/g)].map((pattern) => pattern[1]!);
}

/** hashFiles patterns as used here: `**` crosses directories, `*` does not. */
const matcher = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  );

function filesBelow(directory: string, skip: (path: string) => boolean): string[] {
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(repoRoot, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (skip(path)) continue;
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(directory);
  return files;
}

test("the runtime pack's cache key names every file the pack build shares between targets", () => {
  const patterns = keyPatterns("runtime").map(matcher);
  // Everything in the shared pack package but its tests is read by the pack
  // build: scripts, matrices, the forced include, the committed profiles.
  const inputs = filesBelow(
    "packages/runtime-pack-common",
    (path) => /\/(test|node_modules)$/.test(path) || path.endsWith(".test.ts"),
  );
  expect(inputs).toContain("packages/runtime-pack-common/profiles/linux-x64-gnu.profdata.gz");
  expect(
    inputs.filter((path) => !patterns.some((pattern) => pattern.test(path))),
    "pack build inputs that .github/actions/native-packages/action.yml leaves out of the runtime cache key",
  ).toEqual([]);
});

test("the runtime pack's cache key names the LLVM helper's inputs", () => {
  // The helper compiles the pack's speed units and applies the runtime
  // profile to them, so a pack is rebuilt whenever its helper is.
  const runtime = keyPatterns("runtime");
  expect(keyPatterns("helper").filter((pattern) => !runtime.includes(pattern))).toEqual([]);
});

test("test jobs restore the cache of ICU's archives that the pack build saves", () => {
  // A cache is found by its key and its path list together, so the read-only
  // restore in .github/actions/icu-downloads repeats both exactly.
  type Step = { id?: string; uses?: string; with?: { key?: string; path?: string } };
  const restore = (
    load(readFileSync(join(repoRoot, ".github/actions/icu-downloads/action.yml"), "utf8")) as {
      runs: { steps: Step[] };
    }
  ).runs.steps.find((step) => step.uses?.startsWith("actions/cache/restore@"));
  const saved = (action.runs.steps as Step[]).find((step) => step.id === "icu");
  expect(saved?.with?.key).toContain("icu-downloads-");
  expect(restore?.with?.key).toBe(saved?.with?.key);
  expect(restore?.with?.path).toBe(saved?.with?.path);
});
