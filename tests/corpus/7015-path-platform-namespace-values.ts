// node:path's platform namespaces as VALUES. `posix` and `win32` are
// members of the path module object, so a chosen-at-run-time path API
// (`const api = cond ? win32 : { basename, dirname }`) is that object on
// one arm and a plain record on the other; calls through it dispatch on
// the value, as they do in Node. The namespaces keep the module object's
// identity and member interning (`posix === path.posix`, one closure per
// function), and a function read off the module namespace is the same
// value the named import binds.
import * as path from "node:path";
import { basename, dirname, join, normalize, posix, win32 } from "node:path";

// The platform-namespace choice (the portable-API idiom): win32 here, so
// the calls answer win32's rules on every host, like Node's namespace.
const useWin32 = process.platform === "win32" || "C:\\tmp\\x".includes("\\");
const api = useWin32 ? win32 : { basename, dirname };

const parent = api.dirname("/tmp/pkg/node_modules/@scope/name");
console.log(parent, api.basename(parent), api.dirname(parent));
console.log(api.basename("/a/b/c.txt"), api.basename("C:\\a\\b\\c.txt", ".txt"));

// The same shape through a class/closure boundary and a reassignment.
function pick(flag: boolean): typeof win32 | { basename: typeof basename; dirname: typeof dirname } {
  return flag ? win32 : { basename, dirname };
}
console.log(pick(true).basename("C:\\x\\y.txt"), pick(false).basename("/x/y.txt"));

// A member of the module namespace read as a value is the named import's
// value, and the whole namespace compares by module identity.
type PathModule = typeof import("node:path");
const whole = path as PathModule;
const pathJoin = whole.join;
console.log(pathJoin("a", "b"), pathJoin === path.join, typeof pathJoin);
console.log(typeof posix, typeof win32, posix === path.posix, win32 === path.win32);
console.log(win32.join("a", "c"));

// Direct calls and values mix freely; the namespace value answers every
// lowerable member.
const chosen = useWin32 ? win32 : posix;
console.log(chosen.join("a", "b", "..", "c"), chosen.normalize("a\\\\b//c"));
console.log(chosen.extname("C:\\a\\b.tar.gz"), chosen.isAbsolute("C:\\a"), chosen.sep);
console.log(join("x", "y"), normalize("a//b/../c"));
