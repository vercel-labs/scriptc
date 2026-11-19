// A timer the program left behind prints after the last test: the summary
// block belongs to the end of the report stream, which Node closes once
// the event loop drains, so the late line lands ahead of it.
import { test } from "node:test";

test("quick", () => {});

setTimeout(() => {
  console.log("late log");
}, 5);
