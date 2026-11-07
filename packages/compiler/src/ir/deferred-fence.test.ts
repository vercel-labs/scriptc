import { expect, test } from "vitest";
import { isDeferredDiagnosticFence } from "./deferred-fence.js";

test("a message that ends with its diagnostic's tag is a deferred diagnostic", () => {
  expect(
    isDeferredDiagnosticFence(
      "SC2020",
      "'unescape' has no lowering [SC2020 at /app/a.js:4]",
      "/app/a.js",
    ),
  ).toBe(true);
  expect(
    isDeferredDiagnosticFence("SC1090", "library functions as values [SC1090]", "/app/lib.cjs"),
  ).toBe(true);
});

test("a trap or a dispatch refusal carries no tag", () => {
  expect(
    isDeferredDiagnosticFence(
      "SC9002",
      "unreachable: a non-void function completed without returning",
      "/app/a.js",
    ),
  ).toBe(false);
  expect(
    isDeferredDiagnosticFence(
      "SC2020",
      "reading 'x' through an untyped value is not supported",
      "/app/a.mjs",
    ),
  ).toBe(false);
  // Another diagnostic's tag, or a bracket that is not a tag.
  const js = "/app/a.js";
  expect(isDeferredDiagnosticFence("SC2020", "values [SC1090 at /app/a.js:4]", js)).toBe(false);
  expect(isDeferredDiagnosticFence("SC2020", "items [SC2020x]", js)).toBe(false);
  expect(isDeferredDiagnosticFence("SC2020", "[SC2020 at /app/a.js:4] and more", js)).toBe(false);
});

test("a fence in a TypeScript source keeps the plain throw", () => {
  // The typed-array store through an undefined index, which the compiler's
  // own source holds: tagged, and not a JavaScript statement.
  expect(
    isDeferredDiagnosticFence(
      "SC1090",
      "a typed-array write through an undefined index [SC1090 at /app/a.ts:9]",
      "/app/a.ts",
    ),
  ).toBe(false);
});
