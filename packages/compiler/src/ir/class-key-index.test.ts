import { describe, expect, it } from "vitest";
import { CLASS_KEY_LEN_MIX, classKeyHash, classKeyTail } from "./class-key-index.js";

describe("class key index", () => {
  it("reads the last four key bytes as a little-endian word", () => {
    expect(classKeyTail("object:C00")).toBe(0x3030433a);
    expect(classKeyTail("object:C01")).toBe(0x3130433a);
  });

  it("pins the case a key selects", () => {
    // The emitted code computes the same number from the capsule's key: its
    // length times CLASS_KEY_LEN_MIX plus the word it loads from the tail.
    expect(CLASS_KEY_LEN_MIX).toBe(-1640531535);
    expect(classKeyHash("object:C00")).toBe(1583023140);
    expect(classKeyHash("object:AlphaThing")).toBe(1763540521);
  });

  it("gives keys of one length apart", () => {
    expect(classKeyHash("object:C00")).not.toBe(classKeyHash("object:C01"));
  });

  it("gives two keys sharing a length and a tail the same case", () => {
    expect(classKeyHash("object:AlphaThing")).toBe(classKeyHash("object:BravoThing"));
  });

  it("gives a key too short for a tail -1", () => {
    expect(classKeyHash("abc")).toBe(-1);
  });
});
