// Object spreads of node:path's namespaces copy the exports. The ES module
// namespace has its keys sorted and also `default`, the module object;
// posix, win32 and the default import are module objects, in Node's member
// order. The copies hold the module's own functions.
import * as path from "node:path";
import defaultPath, { posix, win32 } from "node:path";

const fromNamespace = { ...path };
const fromDefault = { ...defaultPath };
const fromPosix = { ...posix };
const fromWin32 = { ...win32 };
const keys = (copy) => JSON.stringify(Object.keys(copy));
console.log(keys(fromNamespace));
console.log(keys(fromPosix));
console.log(keys(fromDefault) === keys(fromPosix));
console.log(keys(fromWin32) === keys(fromPosix));
console.log(fromNamespace.join === path.join, fromNamespace.default === posix, fromPosix.basename === posix.basename);
console.log(fromWin32.join === win32.join, fromWin32.posix === posix, fromPosix.win32 === win32);
console.log(fromWin32._makeLong === win32.toNamespacedPath, fromDefault.sep, fromWin32.sep);
console.log(fromWin32.join("a", "b"), fromNamespace.normalize("/a//b/../c"));
const merged = { first: 0, ...win32, extra: 1 };
console.log(Object.keys(merged)[0], merged.sep, merged.extra, keys(merged));
