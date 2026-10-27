// __dirname and __filename in TypeScript files with import syntax: each
// module reads its own source location, the same strings as
// import.meta.dirname and import.meta.filename.
import { basename, join } from "node:path";
import { helperDir, helperFile } from "./lib/helper.ts";

console.log(typeof __dirname, typeof __filename);
console.log(basename(__dirname), basename(__filename));
console.log(__dirname === import.meta.dirname, __filename === import.meta.filename);
console.log(join(__dirname, "lib") === helperDir, basename(helperFile));
const home = typeof __dirname === "string" && __dirname.endsWith("/lib") ? join(__dirname, "..") : "/tmp";
console.log(home);
