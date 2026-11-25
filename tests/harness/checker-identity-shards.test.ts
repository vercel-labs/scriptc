import { expect, test } from "vitest";
import { shardEntries } from "../../scripts/checker-identity.mjs";

test("checker identity shards partition the program set", () => {
  const entries = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
  const first = shardEntries(entries, "1/2");
  const second = shardEntries(entries, "2/2");
  expect(first).toEqual(["a.ts", "c.ts", "e.ts", "g.ts"]);
  expect(second).toEqual(["b.ts", "d.ts", "f.ts"]);
  // Every program runs in exactly one shard; two shards cover the set once.
  expect([...first, ...second].sort()).toEqual([...entries].sort());
});

test("three shards cover the same programs once each", () => {
  const entries = Array.from({ length: 10 }, (_, index) => `program-${index}.ts`);
  const shards = Array.from({ length: 3 }, (_, index) => shardEntries(entries, `${index + 1}/3`));
  expect(shards.flat().sort()).toEqual(entries);
  expect(new Set(shards.flat()).size).toBe(entries.length);
});

test("an unsharded run keeps the whole set, and a malformed shard is rejected", () => {
  expect(shardEntries(["a.ts"], "")).toEqual(["a.ts"]);
  expect(() => shardEntries(["a.ts"], "1")).toThrow("i/n");
  expect(() => shardEntries(["a.ts"], "0/2")).toThrow("outside");
  expect(() => shardEntries(["a.ts"], "3/2")).toThrow("outside");
});
