import { expect, test } from "vitest";
import { shouldWarnLegacyCExecutable } from "./legacy-c-warning.js";

const executable = {
  executable: true,
  fromC: false,
  backend: undefined,
  sanitize: false,
};

test("warns only for generated legacy C executables on runtime-pack hosts", () => {
  expect(shouldWarnLegacyCExecutable(executable, { SCRIPTC_CC: "clang" }, true)).toBe(true);
  expect(shouldWarnLegacyCExecutable({ ...executable, fromC: true }, { SCRIPTC_CC: "clang" }, true)).toBe(false);
  expect(shouldWarnLegacyCExecutable({ ...executable, backend: "c" }, { SCRIPTC_CC: "clang" }, true)).toBe(false);
  expect(shouldWarnLegacyCExecutable({ ...executable, sanitize: true }, { SCRIPTC_CC: "clang" }, true)).toBe(false);
  expect(shouldWarnLegacyCExecutable({ ...executable, executable: false }, { SCRIPTC_CC: "clang" }, true)).toBe(false);
  expect(shouldWarnLegacyCExecutable(executable, { SCRIPTC_CC: "clang", SCRIPTC_TARGET: "wasm32-wasi" }, true)).toBe(false);
  expect(shouldWarnLegacyCExecutable(executable, { SCRIPTC_CC: "" }, true)).toBe(false);
  expect(shouldWarnLegacyCExecutable(executable, { SCRIPTC_CC: "clang" }, false)).toBe(false);
});
