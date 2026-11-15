// @exit: 0
/* process.title rewrites the process's original argument area on POSIX. A
 * program that renames itself still reads the reporter flags in
 * process.execArgv, as it does under Node. */
import { test } from "node:test";
import assert from "node:assert/strict";

process.title = "scriptc-node-test";
console.log(JSON.stringify(process.execArgv), JSON.stringify(process.argv.slice(2)));

test("runs", () => {
  assert.equal(2 + 2, 4);
});
