import { describe, expect, it } from "vitest";
import {
  CLASS_KEY_LEN_MIX,
  classKeyHash,
  classKeyTail,
  classValueSlot,
} from "./class-key-index.js";

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

  it("measures a key by its UTF-8 bytes, as the emitted code reads it", () => {
    // A class name may hold non-ASCII characters. The stored key length and
    // the tail the emitted code loads are byte measures, so the compiler has
    // to fold the key's UTF-8 bytes: "classval:Émile" is 15 bytes, not the
    // 14 UTF-16 code units a string length would count.
    expect(classKeyTail("object:Ünï")).toBe(2948820636);
    expect(classKeyHash("object:Ünï")).toBe(442311400);
    expect(classKeyHash("classval:Émile")).toBe(715950796);
    expect(classValueSlot("object:Ünï", 5)).toBe(2);
    expect(classValueSlot("classval:Émile", 5)).toBe(28);
  });
});
