// @requires-libnode
// One island package that mixes module kinds, all named by relative paths:
// CommonJS imported from ES code by its extension and by a nested
// package.json, an ES module required from CommonJS, JSON through both
// loaders, and every shape of a relative require (a file before a
// directory, added extensions, a directory's index, a trailing slash).
import { report } from "mixpkg";

console.log(report());
