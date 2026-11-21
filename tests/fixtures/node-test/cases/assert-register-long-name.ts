// @exit: 1
// An unregistered custom assertion whose name is longer than any error
// buffer still throws Node's TypeError with the whole name, never reading
// past the buffer.
import { test } from "node:test";

test("a long unknown assertion name throws", (t) => {
  t.assert.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa();
});
