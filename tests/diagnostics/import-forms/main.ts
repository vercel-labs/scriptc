// The import/export forms that stay OUTSIDE the lowered set now that
// local-module namespace imports, namespace re-exports of user modules,
// and default exports/imports compile: default imports of builtin
// modules, package/builtin re-exports, namespace imports of JSON
// modules, and the module namespace OBJECT as a first-class
// value (member accesses resolve statically; the frozen, alphabetically-
// keyed object itself is not materialized).
import * as helpers from "./helpers.ts";
import os from "node:os";
import * as cfg from "./cfg.json";
import * as legacy from "./legacy.cjs";

// NAMED re-exports from supported builtins lower now (the facade idiom);
// the STAR form still has no lowering — no namespace object to rebuild.
export * from "node:child_process";

const grabbed = helpers;
console.log(grabbed.one(), helpers.one(), os.tmpdir(), cfg.count, legacy.two);
