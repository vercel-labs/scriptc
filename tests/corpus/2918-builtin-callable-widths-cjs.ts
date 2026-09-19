// CommonJS require bindings share the optional/rest builtin value adapters
// and function identities of namespace and destructured reads.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const path = require("node:path") as typeof import("node:path");
const { basename, join, resolve } = require("node:path") as typeof import("node:path");

const base = basename;
const joiner = join;
const resolver = resolve;
const parts = ["cjs", "callable", "value.ts"];

console.log(base("/tmp/cjs-value.ts"), base("/tmp/cjs-value.ts", ".ts"));
console.log(joiner(), joiner(...parts));
console.log(base === path.basename, joiner === path.join, resolver === path.resolve);
console.log(resolver() === process.cwd());
