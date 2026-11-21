// module.findPackageJSON: the nearest package.json for a self-reference, a
// directory, a parent, a file and a nested package's node_modules entry, all
// resolved at build time and answered as Node answers them.
import { findPackageJSON } from "node:module";
import { relative } from "node:path";
import { here, leaf } from "./nested/child.mjs";

const dir = import.meta.dirname;
const rel = (path: string | undefined): string => (path === undefined ? "undefined" : relative(dir, path));

console.log("self", rel(findPackageJSON("@corpus/fpj", import.meta.url)));
console.log("dot", rel(findPackageJSON(".", import.meta.url)));
console.log("up", rel(findPackageJSON("..", import.meta.url)));
console.log("file", rel(findPackageJSON("./nested/leaf.mjs", import.meta.url)));
console.log("dir", rel(findPackageJSON("./nested", import.meta.url)));
console.log("parent", rel(here), rel(leaf));
