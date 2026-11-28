import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readUnitEntry, unitEntryPaths, writeUnitEntry } from "./store.js";
import type { UnitStoreMeta } from "./types.js";

const directories: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-units-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function meta(key: string, digest: string): UnitStoreMeta {
  return {
    schema: "scriptc.unit-meta.v0",
    key,
    summaryDigest: digest,
    summaryBytes: 3,
    unit: {
      id: "lib@1.0.0",
      name: "lib",
      version: "1.0.0",
      app: false,
      files: ["index.ts"],
      dependencies: [],
      mergedFrom: ["lib@1.0.0"],
    },
    compiler: "c".repeat(64),
    keyParts: { files: "f".repeat(64) },
    timings: { graphMs: 1, summaryMs: 1, keyMs: 1 },
  };
}

test("an entry round-trips through summary.json and meta.json", () => {
  const root = tempRoot();
  const key = "a".repeat(64);
  writeUnitEntry(root, key, '{"schema":"x"}', meta(key, "d".repeat(64)));
  const read = readUnitEntry(root, key);
  expect(read).not.toBeNull();
  expect(read!.summary).toBe('{"schema":"x"}');
  expect(read!.meta?.summaryDigest).toBe("d".repeat(64));
  const [summaryPath, metaPath] = unitEntryPaths(root, key);
  expect(JSON.parse(readFileSync(metaPath!, "utf8")).key).toBe(key);
  expect(readFileSync(summaryPath!, "utf8")).toBe('{"schema":"x"}');
});

test("any read failure is a miss", () => {
  const root = tempRoot();
  expect(readUnitEntry(root, "b".repeat(64))).toBeNull();
  const key = "c".repeat(64);
  writeUnitEntry(root, key, "{}", meta(key, "e".repeat(64)));
  writeFileSync(unitEntryPaths(root, key)[0]!, "not json");
  expect(readUnitEntry(root, key)?.summary).toBe("not json");
  rmSync(unitEntryPaths(root, key)[0]!);
  expect(readUnitEntry(root, key)).toBeNull();
});

test("writes install through a private sibling name", () => {
  const root = tempRoot();
  const key = "f".repeat(64);
  writeUnitEntry(root, key, "{}", meta(key, "1".repeat(64)));
  // No private temporary name survives a successful install.
  const entries = readdirSync(join(root, key));
  expect(entries.filter((name) => name.startsWith(".scriptc-"))).toEqual([]);
  expect(entries.sort()).toEqual(["meta.json", "summary.json"]);
});
