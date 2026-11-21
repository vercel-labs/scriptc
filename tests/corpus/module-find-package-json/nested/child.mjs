import { findPackageJSON } from "node:module";
import { relative } from "node:path";

const dir = import.meta.dirname;
console.log("child", relative(dir, findPackageJSON(".", import.meta.url)), relative(dir, findPackageJSON("leaf", import.meta.url)));
export const here = findPackageJSON(".", import.meta.url);
export const leaf = findPackageJSON("leaf", import.meta.url);
