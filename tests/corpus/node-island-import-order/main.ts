// @requires-libnode
// Static imports and re-exports of a Node island package evaluate the
// island module in source order among the native modules a file imports,
// as Node evaluates dependencies: an island package's top-level code runs
// before a native module imported after it, and after one imported before.
import { tag } from "./barrel.ts";
import "./user.ts";
console.log("main", tag("main"));
