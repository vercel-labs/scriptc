// The out-of-scope builtin fences: modules a compiled binary is not going
// to serve say WHY — runtime code evaluation (vm), the inspector protocol,
// the bundled SQLite engine, the deprecated domain module, and Node's
// underscore-prefixed implementation internals — while genuinely pending
// surface (repl here) keeps the plain not-yet wording.
import { runInNewContext } from "node:vm";
import { create } from "domain";
import { DatabaseSync } from "node:sqlite";
import { HTTPParser } from "_http_common";
import { open } from "node:inspector";
import { start } from "node:repl";

console.log(runInNewContext, create, DatabaseSync, HTTPParser, open, start);
