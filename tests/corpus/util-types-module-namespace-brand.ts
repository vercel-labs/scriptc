// util.types.isModuleNamespaceObject over every way a program can hold a
// builtin module value: the ES module spelling (an `import * as` binding, a
// dynamic import) is a module namespace object, while require() and a
// sub-namespace member such as `fs.promises`, `path.win32` or `util.types`
// answer the module's CommonJS exports object — same members, no namespace
// brand.
import * as fs from "node:fs";
import * as path from "node:path";
import * as typesNs from "node:util/types";
import { createRequire } from "node:module";
import { types } from "node:util";

const require = createRequire(import.meta.url);
const brand = (label: string, value: unknown): void =>
  console.log(label, types.isModuleNamespaceObject(value));

// The ES module spelling: namespace objects.
brand("path ns", path);
brand("fs ns", fs);
brand("util/types ns", typesNs);
brand("import nposix", path.posix);
brand("import nwin32", path.win32);
console.log("methods", path.join("a", "b"), path.sep, fs.constants.F_OK > -1);

// The CommonJS spellings: the exports object, no brand.
const reqPath = require("node:path");
const reqPosix = require("node:path/posix");
const reqFs = require("node:fs");
brand("require path", reqPath);
brand("require path posix", reqPosix);
brand("require fs", reqFs);
brand("require fs.promises", reqFs.promises);
brand("fs.promises", fs.promises);
brand("path.posix", path.posix);
brand("util.types", types);
brand("getBuiltinModule", process.getBuiltinModule("node:path"));

// A dynamic import resolves to the ES module namespace object; the same
// module's namespace is one object however it was imported, and a
// sub-namespace member is a different value.
const importedPath = await import("node:path");
const importedPosix = await import("node:path/posix");
const importedTypes = await import("node:util/types");
brand("await import path", importedPath);
brand("await import path posix", importedPosix);
brand("await import types", importedTypes);
brand("await import fs.promises", (await import("node:fs")).promises);
console.log("same namespace", importedPath === path, importedPath.join === path.join);

// Non-module values have no brand.
brand("object", { a: 1 });
brand("array", [1, 2]);
brand("function", path.join);
brand("null", null);
brand("number", 1);
brand("types result", types.isModuleNamespaceObject(path));
