import { expect, test } from "vitest";
import { ffiProfileDigest, unitKey, type UnitKeyInput } from "./key.js";

function input(overrides: Partial<UnitKeyInput> = {}): UnitKeyInput {
  return {
    compiler: "c".repeat(64),
    target: "x86_64-unknown-linux-gnu",
    optimization: "dev",
    lowering: { define: { DEBUG: "1" }, npmStatic: ["a"] },
    ffi: null,
    environment: [["SCRIPTC_SHAPE_OVERLAY", "1"]],
    files: [
      ["index.ts", "1".repeat(64)],
      ["src/x.ts", "2".repeat(64)],
    ],
    dependencies: [["lib@1.0.0", "d".repeat(64)]],
    ...overrides,
  };
}

test("the same inputs give the same key", () => {
  expect(unitKey(input())).toBe(unitKey(input()));
});

test("a file's content or the dependency's summary digest changes the key", () => {
  expect(unitKey(input({ files: [["index.ts", "3".repeat(64)]] }))).not.toBe(unitKey(input()));
  expect(unitKey(input({ dependencies: [["lib@1.0.0", "e".repeat(64)]] }))).not.toBe(
    unitKey(input()),
  );
});

test("option key order does not matter", () => {
  expect(unitKey(input({ lowering: { npmStatic: ["a"], define: { DEBUG: "1" } } }))).toBe(
    unitKey(input()),
  );
});

test("an environment value the frontend's output depends on changes the key", () => {
  expect(unitKey(input({ environment: [["SCRIPTC_SHAPE_OVERLAY", "0"]] }))).not.toBe(
    unitKey(input()),
  );
});

test("the FFI digest ignores the object paths an app's build directory owns", () => {
  const base = {
    ffiFormat: 7,
    functions: [{ name: "hostOpen", symbol: "host_open", params: ["string"], returns: "void" }],
    systemLibraries: ["m"],
  };
  expect(ffiProfileDigest({ ...base, frameworks: [] })).toBe(
    ffiProfileDigest({ ...base, frameworks: [] }),
  );
  expect(ffiProfileDigest({ ...base, frameworks: ["Cocoa"] })).not.toBe(
    ffiProfileDigest({ ...base, frameworks: [] }),
  );
});
