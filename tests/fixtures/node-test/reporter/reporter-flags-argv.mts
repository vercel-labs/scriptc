// @exit: 0
/* The reporter options are runtime flags, not program arguments: a program
 * that prints both sees them in execArgv and not in argv, as Node's own
 * flags behave. */
import { test } from "node:test";
import assert from "node:assert/strict";

console.log(JSON.stringify(process.execArgv), JSON.stringify(process.argv.slice(2)));

test("runs", () => {
  assert.equal(2 + 2, 4);
});
