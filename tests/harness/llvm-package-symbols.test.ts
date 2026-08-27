import { expect, test } from "vitest";
import { validateLlvmHelperExports } from "../../scripts/llvm-package-symbols.mjs";

test("LLVM helper export validation permits Mach-O's linker-defined image header", () => {
  expect(validateLlvmHelperExports(["__mh_execute_header", "_main"])).toEqual({
    hasMain: true,
    unexpected: [],
  });
});

test("LLVM helper export validation requires main and rejects LLVM globals", () => {
  expect(validateLlvmHelperExports(["__mh_execute_header", "_ZN4llvm4errsEv"])).toEqual({
    hasMain: false,
    unexpected: ["_ZN4llvm4errsEv"],
  });
});
