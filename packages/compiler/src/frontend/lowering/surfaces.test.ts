import { expect, test } from "vitest";
import type { Lowerer } from "./lowerer.js";
import { BUILTIN_MODULE_CONSTS, builtinModuleConstOf } from "./surfaces.js";

// builtinModuleConstOf reads only targetPlatform from the lowerer.
const target = (targetPlatform: string): Lowerer => ({ targetPlatform }) as unknown as Lowerer;
const hints = (targetPlatform: string): number[] =>
  ["ADDRCONFIG", "ALL", "V4MAPPED"].map((member) => {
    const value = builtinModuleConstOf(target(targetPlatform), "dns", member);
    if (typeof value !== "number") throw new Error(`dns.${member} is not a number`);
    return value;
  });

test("dns hints follow the target libc's AI_* values", () => {
  // glibc/musl netdb.h: AI_ADDRCONFIG 0x20, AI_ALL 0x10, AI_V4MAPPED 0x8.
  expect(hints("linux")).toEqual([32, 16, 8]);
  // BSD netdb.h (macOS) and ws2tcpip.h (win32): 0x400, 0x100, 0x800.
  expect(hints("darwin")).toEqual([1024, 256, 2048]);
  expect(hints("win32")).toEqual([1024, 256, 2048]);
});

test("dns error codes stay platform-neutral", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    expect(builtinModuleConstOf(target(platform), "dns", "NODATA")).toBe("ENODATA");
    expect(builtinModuleConstOf(target(platform), "dns", "CANCELLED")).toBe("ECANCELLED");
    // node:dns/promises exports the codes only.
    expect(builtinModuleConstOf(target(platform), "dns/promises", "ADDRCONFIG")).toBeUndefined();
  }
});

test("the base table still lists every hint name for the inventory walks", () => {
  for (const member of ["ADDRCONFIG", "ALL", "V4MAPPED"]) {
    expect(Object.hasOwn(BUILTIN_MODULE_CONSTS.dns!, member)).toBe(true);
  }
});
