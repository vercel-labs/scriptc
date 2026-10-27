import { expect, test } from "vitest";
import { systemLibraryLinkerArgs } from "./link-plan-core.js";
import { MACOS_ARM64_TARGET, LINUX_ARM64_GNU_TARGET, LINUX_X64_GNU_TARGET } from "./targets.js";

test("Linux links libm as needed and other system libraries as given", () => {
  for (const target of [LINUX_X64_GNU_TARGET, LINUX_ARM64_GNU_TARGET]) {
    expect(systemLibraryLinkerArgs(target, ["m"])).toEqual([
      "-Wl,--as-needed",
      "-lm",
      "-Wl,--no-as-needed",
    ]);
    expect(systemLibraryLinkerArgs(target, ["z", "m"])).toEqual([
      "-lz",
      "-Wl,--as-needed",
      "-lm",
      "-Wl,--no-as-needed",
    ]);
  }
  expect(systemLibraryLinkerArgs(MACOS_ARM64_TARGET, ["System"])).toEqual(["-lSystem"]);
});
