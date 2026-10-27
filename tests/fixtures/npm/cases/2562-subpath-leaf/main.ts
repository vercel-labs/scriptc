// The program reaches gtsubpath only through its leaf data module (and a
// type from its main entry). The main entry reaches a file whose bundler
// interop the recognizer cannot verify, but no compiled code can load it,
// so the package compiles: a package is judged by what its imported
// subpaths reach.
import type { Manager } from "gtsubpath";
import { managers } from "gtsubpath/dist/data.js";

const names: Manager[] = managers.filter((m) => m.lockfile.endsWith(".yaml"));
console.log(managers.length, names.map((m) => m.name).join(","));
