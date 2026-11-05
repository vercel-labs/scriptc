// Shape inference must not type objects held by module-level bindings as
// native records: a typed return would copy them (identity and writes lost).
import { run } from "module-identity";
console.log(run());
