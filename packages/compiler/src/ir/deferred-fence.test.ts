import { expect, test } from "vitest";
import { isDeferredDiagnosticFence } from "./deferred-fence.js";

test("a message that ends with its diagnostic's tag is a deferred diagnostic", () => {
  expect(
    isDeferredDiagnosticFence("SC2020", "'unescape' has no lowering [SC2020 at /app/a.js:4]"),
  ).toBe(true);
  expect(isDeferredDiagnosticFence("SC1090", "library functions as values [SC1090]")).toBe(true);
});

test("a trap or a dispatch refusal carries no tag", () => {
  expect(
    isDeferredDiagnosticFence(
      "SC9002",
      "unreachable: a non-void function completed without returning",
    ),
  ).toBe(false);
  expect(
    isDeferredDiagnosticFence("SC2020", "reading 'x' through an untyped value is not supported"),
  ).toBe(false);
  // Another diagnostic's tag, or a bracket that is not a tag.
  expect(isDeferredDiagnosticFence("SC2020", "values [SC1090 at /app/a.js:4]")).toBe(false);
  expect(isDeferredDiagnosticFence("SC2020", "items [SC2020x]")).toBe(false);
  expect(isDeferredDiagnosticFence("SC2020", "[SC2020 at /app/a.js:4] and more")).toBe(false);
});
