// @requires-libnode
// An island package that replaces what Node's resolver reads: while
// fs.realpathSync is its wrapper, every file the package requires passes
// through the wrapper, and once the extension table is reordered `./pick`
// names the file Node's order finds. The load plan answers a request only
// while the loader is the one Node started with.
import { report } from "patchpkg";

console.log(report());
