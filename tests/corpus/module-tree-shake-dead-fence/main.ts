// A package barrel re-exports a module the program never reads. That module
// holds code from strings, which the native build has no lowering for; module
// level tree shaking leaves the dead module out of the compiled order, so the
// package still compiles natively. Node runs the same program unchanged.

import { used } from "barrelpkg";

console.log(used());
