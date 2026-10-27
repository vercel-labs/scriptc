// esbuild's lazily initialized ES modules: each package is real esbuild
// output (0.25 plain, and whitespace/syntax minified) of a source whose
// load() require()s an ES module. That module and the module it imports
// run behind the __esm helper: once, at the first load(), assigning
// their interop bindings (a builtin and an external CommonJS package)
// and live exports that the namespace's getters read.
import { describe, load } from "gtesm";
import { describe as dws, load as lws } from "gtesmws";

console.log("main start");
console.log(describe());
console.log(load());
console.log(load());
console.log(dws());
console.log(lws());
console.log(lws());
