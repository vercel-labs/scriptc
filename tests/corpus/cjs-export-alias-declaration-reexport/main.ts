// Two CommonJS modules each bind a same-named top-level local and export
// it (`exports.Kind = KIND`), and the runtime modules' declarations
// re-export core's declarations. An import from a runtime module reads the
// binding that module defines, which its own evaluation set: the shim runs
// before core has run, so core's binding would still be unset.
import { Kind, label, IndexKind, indexLabel, SelectKind, selectLabel } from "./shim.ts";
import { describe, label as coreLabel } from "./core.cjs";
import { label as runtimeLabel } from "./runtime.cjs";

console.log(String(Kind), Kind === Symbol.for("demo.kind"));
console.log(String(IndexKind), IndexKind === Kind);
console.log(String(SelectKind), SelectKind === Kind);
console.log(label, indexLabel, selectLabel);
console.log(runtimeLabel, coreLabel);
console.log(describe());
