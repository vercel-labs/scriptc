// path.parse and path.format through an untyped module binding: a require in a
// TypeScript file types the module as any, so the call site rides the checked
// dynamic tree. parse answers the fresh object with the five ParsedPath keys,
// format reads them as Node's _format does, and a non-string path fails
// Node's validateString with the same TypeError.
const path = require("node:path");

const parsed = path.parse("/srv/app/index.js");
console.log(parsed.root, parsed.dir, parsed.base, parsed.ext, parsed.name);
console.log(JSON.stringify(parsed), Object.keys(parsed).join(","));
console.log(path.format(parsed));

const win = path.win32.parse("C:\\Users\\me\\notes.md");
console.log(win.root, win.dir, win.base, win.ext, win.name, path.win32.format(win));

// A dyn-typed object keys in by property name, as Node's format does.
const shaped: any = { dir: "/a", name: "n", ext: ".e" };
console.log(path.format(shaped), path.posix.format(shaped));

// A statically typed record keeps the verified layout and formats the same.
const record = { root: "/", name: "z", ext: ".y" };
const formatted: any = path.format(record);
console.log(formatted, typeof formatted, formatted.toUpperCase());

// A typed record that crossed an `any` parameter arrives as a checked value
// rather than a plain object, and format still reads its fields as Node does.
function formatAny(pathObject: any): any {
  return path.format(pathObject);
}
console.log(formatAny(record), formatAny({ dir: "/a", name: Buffer.from("bn"), ext: ".e" }));
console.log(formatAny({ dir: "/a", base: Buffer.from("bn.e") }), formatAny({}));

// A path that is not a string fails Node's validateString.
for (const bad of [42, undefined, null]) {
  try {
    path.parse(bad as any);
  } catch (error: any) {
    console.log(error.name, error.code, error.message);
  }
}
