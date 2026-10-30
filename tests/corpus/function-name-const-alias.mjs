// The name of a function value read through a const binding: a builtin
// keeps Node's name (including when destructured), an anonymous function or
// arrow takes the binding's name through parentheses, and an alias of a
// named function keeps the function's name.
import * as path from "node:path";
import * as processModule from "node:process";

const { cwd } = process;
const { cwd: renamed } = processModule;
const join = path.join;
const parenthesized = (function () {});
const arrow = (() => 0);
const nested = ((function () {}));
function named() {}
const alias = named;
const aliasOfAlias = alias;
console.log(cwd.name, renamed.name, join.name);
console.log(parenthesized.name, arrow.name, nested.name);
console.log(alias.name, aliasOfAlias.name);
console.log(cwd === process.cwd, typeof cwd());
