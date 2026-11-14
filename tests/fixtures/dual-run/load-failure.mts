import { test } from "node:test";

// Node's test runner loads TypeScript by erasing types, so this file fails
// to load under `node --test`: an enum is not erasable. The oracle flags
// (--experimental-transform-types) and the compiler both accept it, so the
// reporter has a Node-side failure without a per-file summary to report,
// and still names the file and the failure.
enum Direction {
  Up = "up",
  Down = "down",
}

test("moves one way", () => {
  if (Direction.Up !== "up") throw new Error("bad enum");
});
