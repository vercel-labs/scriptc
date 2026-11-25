// node:path's namespaces carry each other, and _makeLong is Node's
// deprecated alias of toNamespacedPath. All of it is typed and lowers to the
// same native functions.
import * as path from "node:path";
import { posix, win32 } from "node:path";

console.log(path.posix.posix.join("a", "b"));
console.log(path.win32.win32.join("a", "b"));
console.log(path.posix.win32.join("a", "b"));
console.log(path.win32.posix.join("a", "b"));
console.log(JSON.stringify(path.posix.sep), JSON.stringify(path.win32.sep));
console.log(JSON.stringify(path.posix.posix.delimiter), JSON.stringify(path.win32.win32.delimiter));
console.log(JSON.stringify(posix.posix.sep), JSON.stringify(win32.win32.sep));

console.log(path._makeLong("/x/y"));
console.log(path.posix._makeLong("/x/y"));
console.log(path.win32._makeLong("C:\\x"));
console.log(JSON.stringify(path.win32._makeLong("\\\\server\\share\\x")));
console.log(path._makeLong("/x") === path.toNamespacedPath("/x"));
console.log(path.win32._makeLong("C:\\x") === path.win32.toNamespacedPath("C:\\x"));

console.log(path.posix.posix.posix.join("a", "b"));
console.log(path.posix.win32.posix.normalize("a\\b\\..\\c"));
