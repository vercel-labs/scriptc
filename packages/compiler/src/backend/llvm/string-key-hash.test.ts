import { describe, expect, test } from "vitest";
import { literalCapWord, stringKeyHash32 } from "./string-key-hash.js";

// Shared with packages/runtime/test/test_map.c (hash_vectors): the runtime
// computes these for heap strings, the compiler bakes them into literals.
const VECTORS: ReadonlyArray<readonly [string, number]> = [
  ["", 0x993d6596],
  ["a", 0x16793313],
  ["q", 0x81558571],
  ["ab", 0x2985501f],
  ["abc", 0xd7f8c3ad],
  ["alpha", 0x837effcd],
  ["kalomi", 0x4ed53d7d],
  ["hello world!", 0xd1ecb7bb],
  ["\uFFFD", 0xeba2c495],
  ["a much longer key of 31 bytes!!", 0x1a2fe80f],
  ["\u00e9t\u00e9", 0x17c315c4],
];

describe("string key hash", () => {
  test.each(VECTORS)("%j matches the runtime hash", (text, hash) => {
    expect(stringKeyHash32(Buffer.from(text, "utf8"))).toBe(hash);
  });

  test("short keys of adjacent lengths do not collide through the length seed", () => {
    expect(stringKeyHash32(Buffer.from("ab"))).not.toBe(stringKeyHash32(Buffer.from("abc")));
  });

  test("literal capacity word keeps cap = len in the low half", () => {
    for (const [text, hash] of VECTORS) {
      const bytes = Buffer.from(text, "utf8");
      const word = BigInt.asUintN(64, BigInt(literalCapWord(bytes)));
      expect(word & 0xffffffffn).toBe(BigInt(bytes.length));
      expect(word >> 32n).toBe(BigInt(hash));
    }
  });
});
