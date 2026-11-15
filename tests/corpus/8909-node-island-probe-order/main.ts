// @requires-libnode
// Two island packages share a file whose evaluation prints. Node evaluates
// pkg-a first (the entry's first import), so the shared file prints before
// the native module imported next. The build's probe loads every candidate
// in one process and records a shared file's evaluation as the load of
// whichever candidate comes first, so it must take them in the order the
// program evaluates them: probed after pkg-b (dep.ts comes before main.ts
// in the IR), pkg-a's load would look empty and be deferred past the
// native module.
import { a } from "pkg-a";
import "./between.ts";
import { kind } from "./dep.ts";

console.log("main", typeof a, kind);
