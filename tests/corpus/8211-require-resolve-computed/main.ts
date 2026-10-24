// require.resolve with requests computed at run time, called directly and
// read as a value, resolves like Node: builtins, relative files with
// Node's extension search, package "main" and "exports" entries, a
// package's own name, and MODULE_NOT_FOUND for requests that name nothing.
import { resolveAll } from "resolve-probe";

for (const line of resolveAll()) console.log(line);
