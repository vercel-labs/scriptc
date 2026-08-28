// @exit: 1
// A completed failing test verdict takes precedence over Node's fallback
// status 13 when module evaluation remains pending after the loop drains.
import { test } from "node:test";

test("fails before module evaluation stalls", () => {
  throw new Error("deliberate failure");
});

await new Promise<void>(() => {});

export {};
