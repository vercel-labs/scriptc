// node:module — createRequire's LOWERED shape is a const binding over
// createRequire(import.meta.url) (or __filename) whose require calls
// take STATIC string literals (builtins, compiled project modules,
// relative .json documents, --npm-static packages, and installed npm
// packages under --dynamic). Everything else fences by
// name: a base that is not "this file" keeps the member fence (the
// returned require would resolve from a directory the compiler is not
// standing in), a spread argument has no run-time resolution even with
// the runtime-filesystem require, and an unresolved relative target still
// fences by name. A computed specifier lowers through the
// runtime-filesystem require when Node islands are available (SPEC §5.4,
// the limitations page's "Runtime module loading"), and fences only with
// --node-islands=off.
import { createRequire } from "node:module";

// The base names some OTHER file: unrecognized — the member fence.
const req = createRequire("/tmp/parent.js");
console.log(String(req("./config.cjs")));
// The supported base still fences spread requests and unresolved modules.
const require = createRequire(import.meta.url);

// Spread arguments: fenced by name.
const flags: [string] = ["left-pad"];
require(...flags);

// An unresolved relative target.
require("./helper.js");
