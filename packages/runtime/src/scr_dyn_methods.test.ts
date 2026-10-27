import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

test("scr_dyn_methods.h lists every method id the checked-dynamic dispatch compares", () => {
  const script = join(import.meta.dirname, "../../../scripts/gen-dyn-methods.mjs");
  expect(() =>
    execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }),
  ).not.toThrow();
});
