import { expect, test } from "vitest";
import { parseShard, shardItems } from "../../scripts/ts7-shard.mjs";

test("the parity sweep shard partition is stable and covers every fixture once", () => {
  const items = Array.from({ length: 11 }, (_, index) => `fixture-${index}`);
  const first = shardItems(items, parseShard("1/2"));
  const second = shardItems(items, parseShard("2/2"));
  expect(first).toEqual([
    "fixture-0",
    "fixture-2",
    "fixture-4",
    "fixture-6",
    "fixture-8",
    "fixture-10",
  ]);
  expect(second).toEqual(["fixture-1", "fixture-3", "fixture-5", "fixture-7", "fixture-9"]);
  expect([...first, ...second].sort()).toEqual([...items].sort());
});

test("an unset shard keeps every fixture and a malformed one is rejected", () => {
  expect(parseShard(undefined)).toBeNull();
  expect(parseShard("")).toBeNull();
  expect(shardItems(["a"], null)).toEqual(["a"]);
  expect(() => parseShard("0/2")).toThrow("outside");
  expect(() => parseShard("3/2")).toThrow("outside");
  expect(() => parseShard("1")).toThrow("i/n");
});
