// @requires-libnode
// A shared module's export is visible to island code as soon as its own
// declarator ran, not after the whole variable statement: `b = doubled()`
// calls island code (in the `ext` package) that reads the earlier `a`, and
// the aliased `base` is read by the later declarator `e` of its statement.
// Node prints `41 82 7 8 6 5`.
import { snapshot } from "core";
console.log(snapshot());
